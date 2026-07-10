/*
 * Bornes VE — app.js
 * Données officielles IRVE consolidées (Etalab / data.gouv.fr) via la tabular-API.
 * L'utilisateur choisit une commune, filtre par type de prise + fournisseur +
 * puissance, puis suit ses bornes et saisit son propre prix (aucun prix officiel
 * temps réel n'existe pour la recharge : on affiche la tarification déclarée).
 */
'use strict';

// Ressource "dernière version à date" de la base IRVE consolidée (id permanent).
const RES_ID = 'eb76d20a-8501-400e-b336-d85724de5435';
const API = 'https://tabular-api.data.gouv.fr/api/resources/' + RES_ID + '/data/';
const STORE_KEY = 'bornesConfig:v1';

const CONNECTORS = [
  { key: 'prise_type_2',         label: 'Type 2' },
  { key: 'prise_type_combo_ccs', label: 'CCS Combo' },
  { key: 'prise_type_chademo',   label: 'CHAdeMO' },
  { key: 'prise_type_ef',        label: 'Type E/F' },
  { key: 'prise_type_autre',     label: 'Autre' },
];

// ---------- état ----------
let myStations = load();          // [{id, snap, price:{type,value,note}}]
let searchRaw = [];               // dernier résultat brut (points de charge) de la commune
let activeTypes = new Set();      // filtres type de prise sélectionnés
let activeOps = new Set();        // fournisseurs sélectionnés (multi)
let editingId = null;             // borne en cours d'édition de prix
let userPos = null;               // {lat, lon} position GPS de l'utilisateur
let geoSort = false;              // trier la recherche par distance (mode "autour de moi")

// ---------- utils ----------
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch (e) { return []; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(myStations)); } catch (e) {}
}
function truthy(v) {
  if (v === true) return true;
  const s = String(v).toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'oui';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function el(id) { return document.getElementById(id); }
function num(v) { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : 0; }

// Distance haversine en km entre deux points GPS.
function distKm(aLat, aLon, bLat, bLon) {
  if (![aLat, aLon, bLat, bLon].every(isFinite)) return null;
  const R = 6371, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
// Distance depuis l'utilisateur jusqu'à une station (ou null).
function stationDist(s) {
  if (!userPos || !s) return null;
  return distKm(userPos.lat, userPos.lon, num(s.lat), num(s.lon));
}
function fmtDist(km) {
  if (km == null) return '';
  return km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(km < 10 ? 1 : 0) + ' km';
}

// Pastille-logo d'un opérateur : couleur de marque connue sinon couleur
// déterministe (hash du nom) + initiales. Autonome, pas de logo externe.
const BRANDS = [
  { re: /tesla/i,            c: '#e82127', t: 'T'  },
  { re: /lidl/i,             c: '#0050aa', t: 'Li' },
  { re: /ionity/i,           c: '#2b2b40', t: 'IO' },
  { re: /total|totalenergies/i, c: '#e2001a', t: 'TE' },
  { re: /izivia/i,           c: '#00a3a1', t: 'IZ' },
  { re: /freshmile/i,        c: '#5b2a86', t: 'FM' },
  { re: /driveco/i,          c: '#00b2a9', t: 'DC' },
  { re: /allego/i,           c: '#e5007d', t: 'AL' },
  { re: /electra/i,          c: '#1b2440', t: 'EL' },
  { re: /engie|vianeo/i,     c: '#0aa89e', t: 'EN' },
  { re: /bouygues/i,         c: '#e2001a', t: 'BY' },
  { re: /shell/i,            c: '#ed1c24', t: 'SH' },
  { re: /fastned/i,          c: '#ffce00', t: 'FN' },
  { re: /powerdot|power dot/i, c: '#ff5a00', t: 'PD' },
  { re: /chargepoint/i,      c: '#f7901e', t: 'CP' },
];
function initials(name) {
  const w = String(name || '').replace(/[^A-Za-zÀ-ÿ0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[0][0] + w[1][0]).toUpperCase();
}
function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
function logoHtml(op) {
  const brand = BRANDS.find(b => b.re.test(op || ''));
  const color = brand ? brand.c : `hsl(${hashHue(op || '')} 55% 40%)`;
  const txt = brand ? brand.t : initials(op);
  return `<div class="logo" style="background:${color}">${esc(txt)}</div>`;
}

// Connecteurs présents sur un point de charge -> liste de labels.
function connectorsOf(row) {
  return CONNECTORS.filter(c => truthy(row[c.key])).map(c => c.label);
}

// Clé de LIEU : mêmes coordonnées (arrondies ~11 m) = même endroit ; sinon adresse ;
// sinon id station. Permet de factoriser plusieurs stations/pompes au même lieu.
function locKey(r) {
  // 3 décimales ≈ 110 m : fusionne les déclarations d'un même lieu dont les
  // coordonnées diffèrent légèrement (évite les cartes en double).
  const lat = parseFloat(r.consolidated_latitude), lon = parseFloat(r.consolidated_longitude);
  if (isFinite(lat) && isFinite(lon) && (lat || lon)) return lat.toFixed(3) + ',' + lon.toFixed(3);
  const addr = (r.adresse_station || '').trim().toLowerCase();
  if (addr) return 'a:' + addr;
  return 'i:' + (r.id_station_itinerance || r.nom_station || '');
}
// Regroupe les points de charge (rows) par LIEU : additionne les pompes (pdc),
// unionne les prises/opérateurs, garde la puissance max. Un lieu = une carte.
function groupStations(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = locKey(r);
    let s = map.get(key);
    if (!s) {
      s = {
        id: key,
        nom: r.nom_station || r.nom_enseigne || 'Station',
        operateurs: new Set(),
        adresse: r.adresse_station || '',
        commune: r.consolidated_commune || '',
        lat: r.consolidated_latitude, lon: r.consolidated_longitude,
        puissance: 0, connectors: new Set(), pdc: 0, ids: new Set(),
        gratuit: false, cb: false,
        tarification: r.tarification || '', horaires: r.horaires || '',
        maj: r.date_maj || r.last_modified || '',
      };
      map.set(key, s);
    }
    s.pdc += 1;
    s.puissance = Math.max(s.puissance, num(r.puissance_nominale));
    connectorsOf(r).forEach(c => s.connectors.add(c));
    const op = r.nom_operateur || r.nom_enseigne || r.nom_amenageur;
    if (op) s.operateurs.add(op);
    if (r.id_station_itinerance) s.ids.add(r.id_station_itinerance);
    if (truthy(r.gratuit)) s.gratuit = true;
    if (truthy(r.paiement_cb)) s.cb = true;
    if (!s.tarification && r.tarification) s.tarification = r.tarification;
    if (!s.horaires && r.horaires) s.horaires = r.horaires;
    const m = r.date_maj || r.last_modified || '';
    if (m > s.maj) s.maj = m;
  }
  return [...map.values()].map(s => {
    const ops = [...s.operateurs];
    return {
      ...s, connectors: [...s.connectors], ids: [...s.ids],
      operateurs: ops, operateur: ops[0] || '—', nbOperateurs: ops.length,
    };
  });
}

// ---------- API ----------
// Récupère jusqu'à maxPages pages (100 lignes/page) en suivant links.next.
async function fetchRows(params, maxPages) {
  maxPages = maxPages || 1;
  let url = API + '?' + params + '&page_size=100';
  const out = [];
  for (let p = 0; p < maxPages && url; p++) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    (j.data || []).forEach(row => out.push(row));
    url = j.links && j.links.next ? j.links.next : null;
  }
  return out;
}
function fetchByCommune(commune) {
  // jusqu'à 5 pages (500 pdc) pour couvrir les grosses communes
  return fetchRows('consolidated_commune__contains=' + encodeURIComponent(commune.trim()), 5);
}
// Recherche par enseigne / nom de réseau (ex : Lidl, Tesla) — utile car certaines
// bornes ont une commune vide dans la base (invisibles à la recherche par commune).
function fetchByEnseigne(term) {
  return fetchRows('nom_enseigne__contains=' + encodeURIComponent(term.trim()), 3);
}
// Fusionne deux listes de lignes en dédupliquant par __id.
function mergeRows(a, b) {
  const seen = new Set(), out = [];
  for (const row of a.concat(b)) {
    const k = row.__id != null ? row.__id : (row.id_pdc_itinerance || JSON.stringify(row).slice(0, 60));
    if (seen.has(k)) continue;
    seen.add(k); out.push(row);
  }
  return out;
}
function fetchByStationId(id) {
  return fetchRows('id_station_itinerance__exact=' + encodeURIComponent(id), 1);
}
// Bornes dans un carré de rayon ~radiusKm autour de (lat, lon).
function fetchByBBox(lat, lon, radiusKm) {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const q =
    'consolidated_latitude__greater=' + (lat - dLat) +
    '&consolidated_latitude__less=' + (lat + dLat) +
    '&consolidated_longitude__greater=' + (lon - dLon) +
    '&consolidated_longitude__less=' + (lon + dLon);
  // Plus le rayon est grand, plus il y a de bornes : on pagine davantage.
  const pages = Math.min(15, Math.ceil(radiusKm / 5) + 3);
  return fetchRows(q, pages);
}

// ---------- rendu : filtres ----------
function renderTypeChips() {
  el('typeChips').innerHTML = CONNECTORS.map(c =>
    `<span class="chip${activeTypes.has(c.label) ? ' on' : ''}" data-type="${esc(c.label)}">${esc(c.label)}</span>`
  ).join('');
  el('typeChips').querySelectorAll('.chip').forEach(ch => {
    ch.onclick = () => {
      const t = ch.dataset.type;
      activeTypes.has(t) ? activeTypes.delete(t) : activeTypes.add(t);
      ch.classList.toggle('on');
      renderSearch();
    };
  });
}
// Normalisation d'un nom d'opérateur (casse/espaces) pour dédupliquer les
// variantes (« Lidl France » vs « LIDL France »).
function opNorm(o) { return String(o || '').trim().toLowerCase(); }

// Chips fournisseurs (multi-sélection), dédupliqués insensiblement à la casse.
// activeOps contient des clés normalisées ; les chips affichent le 1er libellé vu.
function fillOperatorChips(stations) {
  const disp = new Map();  // norm -> libellé affiché
  stations.forEach(s => (s.operateurs && s.operateurs.length ? s.operateurs : [s.operateur])
    .forEach(o => { if (o) { const n = opNorm(o); if (!disp.has(n)) disp.set(n, o); } }));
  // purge les sélections disparues
  [...activeOps].forEach(n => { if (!disp.has(n)) activeOps.delete(n); });
  const entries = [...disp.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  el('operatorChips').innerHTML = entries.map(([n, d]) =>
    `<span class="chip${activeOps.has(n) ? ' on' : ''}" data-op="${esc(n)}">${esc(d)}</span>`
  ).join('') || '<span class="muted" style="font-size:12px">—</span>';
  el('opCount').textContent = activeOps.size ? '(' + activeOps.size + ' sélectionné' + (activeOps.size > 1 ? 's' : '') + ')' : '';
  el('operatorChips').querySelectorAll('.chip').forEach(ch => {
    ch.onclick = () => {
      const n = ch.dataset.op;
      activeOps.has(n) ? activeOps.delete(n) : activeOps.add(n);
      renderSearch();
    };
  });
}

// ---------- rendu : recherche ----------
function renderSearch() {
  const stations = groupStations(searchRaw);
  fillOperatorChips(stations);
  const minPow = num(el('powerFilter').value);

  const radius = num(el('radiusFilter').value) || 5;
  const filtered = stations.filter(s => {
    if (activeOps.size) {
      const ops = ((s.operateurs && s.operateurs.length) ? s.operateurs : [s.operateur]).map(opNorm);
      if (!ops.some(o => activeOps.has(o))) return false;
    }
    if (minPow && s.puissance < minPow) return false;
    if (activeTypes.size && !s.connectors.some(c => activeTypes.has(c))) return false;
    if (geoSort && userPos) { const d = stationDist(s); if (d != null && d > radius) return false; }
    return true;
  });

  if (geoSort && userPos) {
    filtered.sort((a, b) => (stationDist(a) ?? 1e9) - (stationDist(b) ?? 1e9));
  }

  el('searchStatus').textContent = searchRaw.length
    ? (geoSort ? '📍 ' : '') + `${filtered.length} station(s) · ${searchRaw.length} points de charge trouvés`
    : '';
  el('searchList').innerHTML = filtered.map(s => card(s, false)).join('') ||
    (searchRaw.length ? '<p class="empty">Aucune borne ne correspond aux filtres.</p>' : '');
  wireCards(el('searchList'));
}

// ---------- rendu : mes bornes ----------
function renderMine() {
  const list = el('mineList');
  const sort = el('sortMine').value;
  const items = myStations.slice();
  items.sort((a, b) => {
    if (sort === 'power') return (b.snap.puissance || 0) - (a.snap.puissance || 0);
    if (sort === 'name') return (a.snap.nom || '').localeCompare(b.snap.nom || '');
    if (sort === 'distance') return (stationDist(a.snap) ?? 1e9) - (stationDist(b.snap) ?? 1e9);
    // price : gratuit puis prix croissant, "non renseigné" en dernier
    return priceSortVal(a) - priceSortVal(b);
  });
  el('mineEmpty').style.display = items.length ? 'none' : 'block';
  list.innerHTML = items.map(it => card(it.snap, true, it)).join('');
  wireCards(list);
}
function priceSortVal(it) {
  const p = it.price;
  if (!p || p.type == null) return 1e12;
  if (p.type === 'free') return -1;
  if (!isFinite(p.value) || p.value <= 0) return 1e12;
  return p.value;
}

// ---------- carte ----------
function myPriceLine(it) {
  const p = it && it.price;
  if (!p || p.type == null) return '<div class="myprice"><span class="lbl">Mon prix : </span>non renseigné</div>';
  const unit = { kwh: '€/kWh', session: '€/session', min: '€/min', free: '' }[p.type];
  const val = p.type === 'free' ? 'Gratuit' : (Number(p.value).toFixed(2) + ' ' + unit);
  const note = p.note ? `<span class="note">${esc(p.note)}</span>` : '';
  return `<div class="myprice"><span class="lbl">Mon prix : </span>${esc(val)}${note}</div>`;
}
function card(s, mine, it) {
  const added = myStations.some(m => m.id === s.id);
  const badges = [];
  const d = stationDist(s);
  if (d != null) badges.push(`<span class="badge dist">📍 ${fmtDist(d)}</span>`);
  if (s.puissance) badges.push(`<span class="badge pow">${s.puissance} kW</span>`);
  if (s.pdc) badges.push(`<span class="badge">⚡ ${s.pdc} pompe${s.pdc > 1 ? 's' : ''}</span>`);
  s.connectors.forEach(c => badges.push(`<span class="badge">${esc(c)}</span>`));
  if (s.gratuit) badges.push('<span class="badge free">Gratuit</span>');
  if (s.cb) badges.push('<span class="badge cb">CB</span>');

  const tarif = s.tarification
    ? `<div class="tarif">💶 Tarif déclaré : ${esc(s.tarification)}</div>` : '';
  const maj = s.maj ? `<div class="maj">🗓️ maj officielle : ${esc(String(s.maj).slice(0, 10))}</div>` : '';
  const mapUrl = (s.lat && s.lon)
    ? `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}` : '';

  let actions;
  if (mine) {
    actions = `
      <button class="btn-price" data-price="${esc(s.id)}">💶 Mon prix</button>
      ${mapUrl ? `<a class="btn-map" href="${mapUrl}" target="_blank" rel="noopener">🗺️ Carte</a>` : ''}
      <button class="btn-del" data-del="${esc(s.id)}">🗑️</button>`;
  } else {
    actions = `
      <button class="${added ? 'btn-added' : 'btn-add'}" data-add="${esc(s.id)}" ${added ? 'disabled' : ''}>
        ${added ? '✅ Suivie' : '⭐ Suivre'}</button>
      ${mapUrl ? `<a class="btn-map" href="${mapUrl}" target="_blank" rel="noopener">🗺️ Carte</a>` : ''}`;
  }

  return `<div class="card" data-card="${esc(s.id)}">
    <div class="card-top">
      <div class="card-main">
        ${logoHtml(s.operateur)}
        <div style="min-width:0">
          <p class="card-name">${esc(s.nom)}</p>
          <p class="card-op">⚡ ${esc(s.operateur)}${s.nbOperateurs > 1 ? ' +' + (s.nbOperateurs - 1) + ' réseau' + (s.nbOperateurs > 2 ? 'x' : '') : ''}</p>
          <p class="card-addr">📍 ${esc(s.adresse)}</p>
        </div>
      </div>
    </div>
    <div class="badges">${badges.join('')}</div>
    ${mine ? myPriceLine(it) : ''}
    ${tarif}
    ${s.horaires ? `<div class="maj">🕑 ${esc(s.horaires)}</div>` : ''}
    ${maj}
    <div class="card-actions">${actions}</div>
  </div>`;
}

// stocke le "snap" (sous-ensemble sérialisable) d'une station groupée
function snapOf(s) {
  return {
    id: s.id, nom: s.nom, operateur: s.operateur, nbOperateurs: s.nbOperateurs || 1,
    adresse: s.adresse, commune: s.commune,
    lat: s.lat, lon: s.lon, puissance: s.puissance, pdc: s.pdc, connectors: s.connectors,
    ids: s.ids || [], gratuit: s.gratuit, cb: s.cb,
    tarification: s.tarification, horaires: s.horaires, maj: s.maj,
  };
}

function wireCards(root) {
  root.querySelectorAll('[data-add]').forEach(b => b.onclick = () => addStation(b.dataset.add));
  root.querySelectorAll('[data-del]').forEach(b => b.onclick = () => delStation(b.dataset.del));
  root.querySelectorAll('[data-price]').forEach(b => b.onclick = () => openPrice(b.dataset.price));
}

function addStation(id) {
  const s = groupStations(searchRaw).find(x => x.id === id);
  if (!s || myStations.some(m => m.id === id)) return;
  myStations.push({ id, snap: snapOf(s), price: { type: null, value: 0, note: '' } });
  save();
  renderSearch();
  renderMine();
}
function delStation(id) {
  myStations = myStations.filter(m => m.id !== id);
  save();
  renderMine();
  renderSearch();
}

// ---------- éditeur de prix ----------
function openPrice(id) {
  const it = myStations.find(m => m.id === id);
  if (!it) return;
  editingId = id;
  el('pmTitle').textContent = it.snap.nom;
  el('pmType').value = it.price.type || 'kwh';
  el('pmValue').value = it.price.value || '';
  el('pmNote').value = it.price.note || '';
  el('priceModal').hidden = false;
}
function closePrice() { el('priceModal').hidden = true; editingId = null; }
function savePrice() {
  const it = myStations.find(m => m.id === editingId);
  if (it) {
    const type = el('pmType').value;
    it.price = { type, value: type === 'free' ? 0 : num(el('pmValue').value), note: el('pmNote').value.trim() };
    save();
    renderMine();
  }
  closePrice();
}

// ---------- actualisation officielle ----------
async function refreshAll() {
  if (!myStations.length) return;
  const btn = el('refreshAll');
  btn.innerHTML = '<span class="spin">🔄</span>';
  let ok = 0;
  for (const it of myStations) {
    try {
      let rows = [];
      const ids = (it.snap && it.snap.ids) || [];
      if (ids.length) {
        for (const id of ids) rows = rows.concat(await fetchByStationId(id));
      } else if (isFinite(num(it.snap.lat)) && num(it.snap.lat) !== 0) {
        rows = await fetchByBBox(num(it.snap.lat), num(it.snap.lon), 0.3);  // ~300 m
      } else {
        rows = await fetchByStationId(it.id);
      }
      if (rows.length) {
        const grouped = groupStations(rows);
        const g = grouped.find(x => x.id === it.id) || grouped[0];
        if (g) { it.snap = snapOf(g); ok++; }
      }
    } catch (e) { /* on garde le cache */ }
  }
  save();
  renderMine();
  btn.innerHTML = '🔄';
  el('mineList').insertAdjacentHTML('afterbegin',
    `<p class="status">✅ ${ok}/${myStations.length} borne(s) actualisée(s) depuis la base officielle.</p>`);
  setTimeout(() => { const s = el('mineList').querySelector('.status'); if (s) s.remove(); }, 3500);
}

// ---------- recherche ----------
async function doSearch() {
  const term = el('communeInput').value.trim();
  if (!term) { el('searchStatus').textContent = 'Entre une commune ou une enseigne.'; return; }
  geoSort = false;                       // recherche texte : pas de tri distance
  el('searchStatus').innerHTML = '<span class="spin">⏳</span> Recherche officielle…';
  el('searchList').innerHTML = '';
  try {
    // Commune ET enseigne en parallèle (ex : « Lidl », « Tesla » n'ont pas de commune).
    const [byCom, byEns] = await Promise.all([
      fetchByCommune(term).catch(() => []),
      fetchByEnseigne(term).catch(() => []),
    ]);
    searchRaw = mergeRows(byCom, byEns);
    renderSearch();
    if (!searchRaw.length) el('searchStatus').textContent = 'Aucune borne trouvée pour « ' + term + ' ».';
  } catch (e) {
    el('searchStatus').textContent = '⚠️ Erreur réseau (' + e.message + '). Réessaie.';
  }
}

// ---------- géolocalisation ----------
async function loadAround() {
  const radius = num(el('radiusFilter').value) || 5;
  el('searchStatus').innerHTML = '<span class="spin">⏳</span> Bornes autour de moi (' + radius + ' km)…';
  el('searchList').innerHTML = '';
  try {
    searchRaw = await fetchByBBox(userPos.lat, userPos.lon, radius);
    geoSort = true;
    renderSearch();
    renderMine();                        // affiche aussi la distance sur "Mes bornes"
    if (!el('searchList').children.length) el('searchStatus').textContent = 'Aucune borne dans ce rayon.';
  } catch (e) {
    el('searchStatus').textContent = '⚠️ Erreur réseau (' + e.message + ').';
  }
}
// Plugin Capacitor Geolocation si dispo (gère la permission runtime Android),
// sinon navigator.geolocation (PWA / navigateur).
function capGeo() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation) || null;
}
async function geolocate() {
  el('communeInput').value = '';
  el('searchStatus').innerHTML = '<span class="spin">📍</span> Localisation en cours…';
  const G = capGeo();
  if (G) {
    try {
      const perm = await G.requestPermissions();
      const st = perm && (perm.location || perm.coarseLocation);
      if (st === 'denied') { el('searchStatus').textContent = '⚠️ Localisation refusée dans les réglages.'; return; }
      const pos = await G.getCurrentPosition({ enableHighAccuracy: true, timeout: 12000 });
      userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      loadAround();
    } catch (e) { el('searchStatus').textContent = '⚠️ Localisation indisponible (' + (e.message || e) + ').'; }
    return;
  }
  if (!navigator.geolocation) { el('searchStatus').textContent = 'Géolocalisation indisponible sur cet appareil.'; return; }
  navigator.geolocation.getCurrentPosition(
    pos => { userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude }; loadAround(); },
    err => { el('searchStatus').textContent = '⚠️ Localisation refusée / indisponible (' + err.message + ').'; },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
}

// ---------- carte (Leaflet) ----------
let map = null, markerLayer = null, meMarker = null;
const MARKER_ICON = () => L.icon({
  iconUrl: 'vendor/leaflet/images/marker-icon.png',
  iconRetinaUrl: 'vendor/leaflet/images/marker-icon-2x.png',
  shadowUrl: 'vendor/leaflet/images/marker-shadow.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
});
function mapPopup(it) {
  const s = it.snap;
  const p = it.price;
  let price = '';
  if (p && p.type) {
    const unit = { kwh: '€/kWh', session: '€/session', min: '€/min', free: '' }[p.type];
    price = `<div class="p-price">💶 ${p.type === 'free' ? 'Gratuit' : (Number(p.value).toFixed(2) + ' ' + unit)}</div>`;
  }
  const nav = (s.lat && s.lon)
    ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}" target="_blank" rel="noopener">🧭 Y aller</a>` : '';
  return `<b>${esc(s.nom)}</b>
    <div class="p-op">⚡ ${esc(s.operateur)}${s.puissance ? ' · ' + s.puissance + ' kW' : ''}</div>
    <div>${esc(s.adresse || '')}</div>${price}${nav}`;
}
function showMap() {
  const withCoords = myStations.filter(m => isFinite(num(m.snap.lat)) && isFinite(num(m.snap.lon)) && num(m.snap.lat) !== 0);
  el('mapEmpty').style.display = withCoords.length ? 'none' : 'block';
  el('map').style.display = withCoords.length ? 'block' : 'none';
  if (!withCoords.length) return;

  if (!map) {
    map = L.map('map', { zoomControl: true }).setView([46.6, 2.4], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
  }
  markerLayer.clearLayers();
  const pts = [];
  for (const it of withCoords) {
    const lat = num(it.snap.lat), lon = num(it.snap.lon);
    L.marker([lat, lon], { icon: MARKER_ICON() }).addTo(markerLayer).bindPopup(mapPopup(it));
    pts.push([lat, lon]);
  }
  if (userPos) {
    if (meMarker) meMarker.remove();
    meMarker = L.circleMarker([userPos.lat, userPos.lon], {
      radius: 8, color: '#38bdf8', fillColor: '#38bdf8', fillOpacity: 0.9,
    }).addTo(map).bindPopup('📍 Ma position');
    pts.push([userPos.lat, userPos.lon]);
  }
  // Leaflet a besoin que le conteneur soit visible pour se dimensionner.
  setTimeout(() => {
    map.invalidateSize();
    if (pts.length === 1) map.setView(pts[0], 14);
    else map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
  }, 60);
}

// ---------- version / mise à jour manuelle ----------
function cmpVer(a, b) {
  const x = String(a).replace(/^v/, '').split('.'), y = String(b).replace(/^v/, '').split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0);
    if (d) return d;
  }
  return 0;
}
async function checkUpdate() {
  const st = el('updState');
  st.textContent = ' · vérification…';
  try {
    const r = await fetch('https://api.github.com/repos/' + (window.UPDATE_REPO) +
      '/releases/latest?_=' + Date.now(), { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rel = await r.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    if (cmpVer(latest, window.APP_VERSION) > 0) {
      st.innerHTML = ' · <b style="color:#22c55e">v' + esc(latest) + ' disponible !</b>';
      const apk = (rel.assets || []).find(a => /\.apk$/i.test(a.name));
      window.open(apk ? apk.browser_download_url : rel.html_url, '_blank');
    } else {
      st.innerHTML = ' · <span style="color:#22c55e">à jour ✅</span>';
    }
  } catch (e) { st.textContent = ' · échec de la vérification (hors ligne ?)'; }
}

// ---------- tabs ----------
function initTabs() {
  document.querySelectorAll('.tab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      el('tab-' + t.dataset.tab).classList.add('active');
      if (t.dataset.tab === 'map') showMap();
    };
  });
}

// ---------- init ----------
function init() {
  initTabs();
  renderTypeChips();
  renderMine();
  el('searchBtn').onclick = doSearch;
  el('communeInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  el('geoBtn').onclick = geolocate;
  el('powerFilter').onchange = renderSearch;
  el('radiusFilter').onchange = () => { if (geoSort && userPos) loadAround(); else renderSearch(); };
  el('sortMine').onchange = renderMine;
  el('refreshAll').onclick = refreshAll;
  el('appVersion').textContent = 'v' + (window.APP_VERSION || '?');
  el('verChip').textContent = 'v' + (window.APP_VERSION || '?');
  el('checkUpdBtn').onclick = checkUpdate;
  el('pmCancel').onclick = closePrice;
  el('pmSave').onclick = savePrice;
  el('priceModal').addEventListener('click', e => { if (e.target === el('priceModal')) closePrice(); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
document.addEventListener('DOMContentLoaded', init);
