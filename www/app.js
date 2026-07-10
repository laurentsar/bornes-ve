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
let activeOps = new Set();        // fournisseurs sélectionnés (multi)
let editingId = null;             // borne en cours d'édition de prix
let userPos = null;               // {lat, lon} position GPS de l'utilisateur
let geoSort = false;              // trier la recherche par distance (mode "autour de moi")
let expandedCities = new Set();   // villes dépliées dans "Mes bornes" (fermées par défaut)
let _revGeoDone = new Set();      // favoris déjà reverse-géocodés (ville manquante)

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

// Logo d'un opérateur : favicon OFFICIEL de la marque (via Google) quand le
// réseau est connu (domaine ci-dessous), avec repli sur une pastille initiales.
const BRANDS = [
  { re: /tesla/i,            c: '#e82127', t: 'T',  d: 'tesla.com' },
  { re: /lidl/i,             c: '#0050aa', t: 'Li', d: 'lidl.fr' },
  { re: /ionity/i,           c: '#2b2b40', t: 'IO', d: 'ionity.eu' },
  { re: /total|totalenergies/i, c: '#e2001a', t: 'TE', d: 'totalenergies.fr' },
  { re: /izivia/i,           c: '#00a3a1', t: 'IZ', d: 'izivia.com' },
  { re: /freshmile/i,        c: '#5b2a86', t: 'FM', d: 'freshmile.com' },
  { re: /driveco/i,          c: '#00b2a9', t: 'DC', d: 'driveco.com' },
  { re: /allego/i,           c: '#e5007d', t: 'AL', d: 'allego.eu' },
  { re: /electra/i,          c: '#1b2440', t: 'EL', d: 'electra.com' },
  { re: /engie|vianeo/i,     c: '#0aa89e', t: 'EN', d: 'engie.fr' },
  { re: /bouygues/i,         c: '#e2001a', t: 'BY', d: 'bouygues-es.com' },
  { re: /shell/i,            c: '#ed1c24', t: 'SH', d: 'shell.fr' },
  { re: /fastned/i,          c: '#ffce00', t: 'FN', d: 'fastnedcharging.com' },
  { re: /power ?dot/i,       c: '#ff5a00', t: 'PD', d: 'power-dot.com' },
  { re: /chargepoint/i,      c: '#f7901e', t: 'CP', d: 'chargepoint.com' },
  { re: /qovoltis/i,         c: '#1f6feb', t: 'QO', d: 'qovoltis.com' },
  { re: /atlante/i,          c: '#00a651', t: 'AT', d: 'atlante.com' },
  { re: /zunder/i,           c: '#ff4d00', t: 'ZU', d: 'zunder.com' },
  { re: /bump/i,             c: '#00c2a8', t: 'BU', d: 'bump-charge.com' },
  { re: /carrefour/i,        c: '#0055a4', t: 'CA', d: 'carrefour.fr' },
  { re: /e\.?\s?leclerc|leclerc/i, c: '#0066b3', t: 'LE', d: 'e.leclerc' },
  { re: /intermarch/i,       c: '#e2001a', t: 'IN', d: 'intermarche.com' },
  { re: /auchan/i,           c: '#e2001a', t: 'AU', d: 'auchan.fr' },
  { re: /(syst[eè]me|super|hyper) u|magasins? u/i, c: '#e2001a', t: 'U', d: 'magasins-u.com' },
  { re: /monta/i,            c: '#111111', t: 'MO', d: 'monta.com' },
  { re: /last mile|lmc/i,    c: '#7c3aed', t: 'LM', d: 'lastmilesolutions.com' },
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
  // Pastille initiales = fond/repli. Si la marque est connue, on superpose son
  // favicon officiel ; en cas d'échec de chargement, l'img se retire (onerror).
  const badge = `<span class="logo" style="background:${color}">${esc(txt)}</span>`;
  const img = brand && brand.d
    ? `<img class="logo-img" src="https://www.google.com/s2/favicons?domain=${brand.d}&sz=64" alt="" loading="lazy" onerror="this.remove()">`
    : '';
  return `<span class="logo-wrap">${badge}${img}</span>`;
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
        puissance: 0, connectors: new Set(), pdcKeys: new Set(), ids: new Set(),
        gratuit: false, cb: false,
        tarification: r.tarification || '', horaires: r.horaires || '',
        maj: r.date_maj || r.last_modified || '',
      };
      map.set(key, s);
    }
    // Nb de pompes = points de charge DISTINCTS. La base contient des lignes en
    // double (même id_pdc) et parfois plusieurs lignes par pompe (1 par prise) :
    // une seule clé par pompe = id_pdc_itinerance, sinon id_pdc_local, sinon la
    // ligne elle-même (__id) pour ne jamais perdre ni doubler une pompe.
    s.pdcKeys.add(r.id_pdc_itinerance || r.id_pdc_local || ('row:' + (r.__id != null ? r.__id : Math.random())));
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
      pdc: s.pdcKeys.size,
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
// Recherche dans l'adresse (rattrape les bornes dont la commune consolidée est vide).
function fetchByAdresse(term) {
  return fetchRows('adresse_station__contains=' + encodeURIComponent(term.trim()), 3);
}
// Géocode un nom de VILLE via l'API Adresse (BAN) gouv : tolérante aux accents et
// à la casse, sans clé, CORS ouvert. Renvoie {lat, lon, label} ou null.
async function geocodeCity(term) {
  const url = 'https://api-adresse.data.gouv.fr/search/?type=municipality&limit=1&q=' + encodeURIComponent(term.trim());
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const f = (j.features || [])[0];
  if (!f || !f.geometry) return null;
  return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: f.properties && f.properties.label };
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
// Normalisation d'un nom d'opérateur (casse/espaces) pour dédupliquer les
// variantes (« Lidl France » vs « LIDL France »).
function opNorm(o) { return String(o || '').trim().toLowerCase(); }

// Menu déroulant MULTICHOIX des fournisseurs (cases à cocher), dédupliqué
// insensiblement à la casse. activeOps = clés normalisées ; libellé = 1er vu.
function opDisplayMap(stations) {
  const disp = new Map();  // norm -> libellé affiché
  stations.forEach(s => (s.operateurs && s.operateurs.length ? s.operateurs : [s.operateur])
    .forEach(o => { if (o) { const n = opNorm(o); if (!disp.has(n)) disp.set(n, o); } }));
  return disp;
}
let opDisp = new Map();   // norm -> libellé affiché (dernier menu construit)
function updateOpBtn() {
  const btn = el('opDropBtn');
  let label;
  if (activeOps.size === 0) label = 'Tous les fournisseurs';
  else if (activeOps.size === 1) label = opDisp.get([...activeOps][0]) || '1 fournisseur';
  else label = activeOps.size + ' fournisseurs';
  btn.innerHTML = esc(label) + ' <span class="ms-caret">▾</span>';
  btn.classList.toggle('has', activeOps.size > 0);
}
function renderOpMenu(stations) {
  opDisp = opDisplayMap(stations);
  [...activeOps].forEach(n => { if (!opDisp.has(n)) activeOps.delete(n); });  // purge disparus
  const entries = [...opDisp.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  el('opList').innerHTML = entries.length ? entries.map(([n, d]) =>
    `<label class="ms-opt" data-op="${esc(n)}" data-name="${esc(d.toLowerCase())}">
      <input type="checkbox" ${activeOps.has(n) ? 'checked' : ''}><span>${esc(d)}</span></label>`
  ).join('') : '<div class="ms-empty">Aucun fournisseur (lance une recherche).</div>';
  el('opList').querySelectorAll('.ms-opt input').forEach(cb => {
    // onchange met à jour les résultats SANS reconstruire le menu (le menu reste ouvert).
    cb.onchange = () => {
      const n = cb.closest('.ms-opt').dataset.op;
      cb.checked ? activeOps.add(n) : activeOps.delete(n);
      updateOpBtn();
      renderResults();
    };
  });
  filterOpList();
  updateOpBtn();
}
// Filtre visuel de la liste selon le champ de recherche du menu.
function filterOpList() {
  const q = (el('opSearch').value || '').trim().toLowerCase();
  el('opList').querySelectorAll('.ms-opt').forEach(o => {
    o.classList.toggle('hide', q && !o.dataset.name.includes(q));
  });
}

// ---------- rendu : recherche ----------
// renderSearch = après une NOUVELLE recherche : (re)construit le menu fournisseurs
// PUIS les résultats. renderResults = juste re-filtrer/afficher (changement d'option),
// SANS reconstruire le menu (sinon le clic sur une case détache le DOM et ferme le menu).
let currentStations = [];
function renderSearch() {
  currentStations = groupStations(searchRaw);
  renderOpMenu(currentStations);
  renderResults();
}
function renderResults() {
  const minPow = num(el('powerFilter').value);
  const radius = num(el('radiusFilter').value) || 5;
  const filtered = currentStations.filter(s => {
    if (activeOps.size) {
      const ops = ((s.operateurs && s.operateurs.length) ? s.operateurs : [s.operateur]).map(opNorm);
      if (!ops.some(o => activeOps.has(o))) return false;
    }
    if (minPow && s.puissance < minPow) return false;
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

  // Regroupement par VILLE : un en-tête par commune, favoris triés à l'intérieur.
  const groups = new Map();
  for (const it of items) {
    const ville = (it.snap.commune || '').trim() || 'Autres';
    if (!groups.has(ville)) groups.set(ville, []);
    groups.get(ville).push(it);
  }
  const villes = [...groups.keys()].sort((a, b) => {
    if (a === 'Autres') return 1; if (b === 'Autres') return -1;
    return a.localeCompare(b);
  });
  // Un menu dépliant par ville, FERMÉ par défaut (expandedCities vide au départ).
  list.innerHTML = villes.map(v => {
    const g = groups.get(v);
    const open = expandedCities.has(v);
    return `<div class="city-group">
      <button class="city-head${open ? ' open' : ''}" data-city="${esc(v)}">
        <span class="caret">▸</span><span class="city-name">🏙️ ${esc(v)}</span>
        <span class="city-n">${g.length}</span></button>
      <div class="city-body"${open ? '' : ' hidden'}>${g.map(it => card(it.snap, true, it)).join('')}</div>
    </div>`;
  }).join('');
  wireCards(list);
  list.querySelectorAll('.city-head').forEach(h => {
    h.onclick = () => {
      const v = h.dataset.city;
      if (expandedCities.has(v)) expandedCities.delete(v); else expandedCities.add(v);
      const openNow = expandedCities.has(v);
      h.classList.toggle('open', openNow);
      const body = h.nextElementSibling;
      if (body) body.hidden = !openNow;
    };
  });
  fillMissingCities();   // complète les villes manquantes (reverse-géocodage), async
}

// Reverse-géocode les favoris sans commune (coords → ville) pour que chaque favori
// ait toujours un nom de ville (regroupement propre au lieu de « Autres »).
async function fillMissingCities() {
  const todo = myStations.filter(m => !(m.snap.commune || '').trim() &&
    isFinite(num(m.snap.lat)) && num(m.snap.lat) !== 0 && !_revGeoDone.has(m.id));
  if (!todo.length) return;
  let changed = false;
  for (const m of todo) {
    _revGeoDone.add(m.id);
    try {
      const r = await fetch('https://api-adresse.data.gouv.fr/reverse/?lat=' + num(m.snap.lat) + '&lon=' + num(m.snap.lon));
      if (!r.ok) continue;
      const j = await r.json();
      const p = ((j.features || [])[0] || {}).properties;
      if (p && p.city) { m.snap.commune = p.city; changed = true; }
    } catch (e) { /* silencieux */ }
  }
  if (changed) { save(); renderMine(); }
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
  // Itinéraire GPS direct (lance la navigation Google Maps vers la borne).
  const navUrl = (s.lat && s.lon)
    ? `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving` : '';
  const navBtn = navUrl
    ? `<a class="btn-nav" href="${navUrl}" target="_blank" rel="noopener" title="Y aller (itinéraire GPS)">🧭 Y aller</a>` : '';
  const mapBtn = mapUrl
    ? `<a class="btn-map" href="${mapUrl}" target="_blank" rel="noopener" title="Voir sur la carte">🗺️</a>` : '';
  // Id d'ACTION : pour un favori on utilise l'id du favori (it.id) — le snap.id peut
  // avoir changé après une actualisation, ce qui cassait suppression / prix.
  const aid = (mine && it) ? it.id : s.id;
  // Croisement IRVE × ChargePrice : bouton visible si une clé ChargePrice est saisie.
  const cpBtn = (cpKey() && s.lat && s.lon)
    ? `<button class="btn-cp" data-cp="${esc(aid)}" title="Prix réels multi-opérateurs (ChargePrice)">💶 Prix réels</button>` : '';

  let actions;
  if (mine) {
    actions = `
      <button class="btn-price" data-price="${esc(aid)}">💶 Mon prix</button>
      ${cpBtn}${navBtn}${mapBtn}
      <button class="btn-del" data-del="${esc(aid)}">🗑️</button>`;
  } else {
    actions = `
      <button class="${added ? 'btn-added' : 'btn-add'}" data-add="${esc(aid)}" ${added ? 'disabled' : ''}>
        ${added ? '✅ Suivie' : '⭐ Suivre'}</button>
      ${cpBtn}${navBtn}${mapBtn}`;
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
  root.querySelectorAll('[data-cp]').forEach(b => b.onclick = () => openChargePrice(b.dataset.cp));
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
        if (g) { it.snap = snapOf(g); it.snap.id = it.id; ok++; }  // garde l'id du favori stable
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
    // 1) On tente de géocoder le terme comme une VILLE (accent/casse-proof).
    const geo = await geocodeCity(term).catch(() => null);
    let rows;
    if (geo) {
      // Ville reconnue → bbox autour du centre (rattrape les communes VIDES et les
      // accents, ex Souillac/Groléjac) + enseigne (marques présentes dans la ville).
      const [bboxRows, ensRows] = await Promise.all([
        fetchByBBox(geo.lat, geo.lon, 8).catch(() => []),
        fetchByEnseigne(term).catch(() => []),
      ]);
      rows = mergeRows(bboxRows, ensRows);
    } else {
      // Pas une ville (marque / adresse) → commune + enseigne + adresse.
      const [c, e, a] = await Promise.all([
        fetchByCommune(term).catch(() => []),
        fetchByEnseigne(term).catch(() => []),
        fetchByAdresse(term).catch(() => []),
      ]);
      rows = mergeRows(mergeRows(c, e), a);
    }
    searchRaw = rows;
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
// Acquisition SILENCIEUSE de la position au démarrage — UNIQUEMENT si la permission
// est DÉJÀ accordée (aucune demande auto, « autour de moi » n'est pas activé par
// défaut). Sinon on attend que l'utilisateur touche le bouton 📍.
async function ensurePosition() {
  if (userPos) return;
  const G = capGeo();
  try {
    if (G && G.checkPermissions) {
      const p = await G.checkPermissions();
      const st = p && (p.location || p.coarseLocation);
      if (st !== 'granted') return;   // pas déjà autorisé → on ne demande rien
      const pos = await G.getCurrentPosition({ enableHighAccuracy: false, timeout: 10000 });
      userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    } else if (navigator.permissions && navigator.geolocation) {
      // Navigateur : on n'interroge la position que si déjà accordée (pas de prompt).
      const status = await navigator.permissions.query({ name: 'geolocation' }).catch(() => null);
      if (!status || status.state !== 'granted') return;
      await new Promise(res => navigator.geolocation.getCurrentPosition(
        p => { userPos = { lat: p.coords.latitude, lon: p.coords.longitude }; res(); },
        () => res(),
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }));
    }
  } catch (e) { /* silencieux */ }
  if (userPos) { renderMine(); if (searchRaw.length) renderResults(); }
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
// MAJ in-app : si le plugin natif est présent (APK Android), on télécharge et on
// INSTALLE l'APK directement (comme Flux RSS) ; sinon on ouvre le lien (PWA/navigateur).
// `statusEl` (optionnel) reçoit l'état ; `onEnd` rétablit l'UI en cas d'échec.
async function installApkUpdate(apkUrl, statusEl, onEnd) {
  const UP = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.UpdatePlugin;
  if (UP && apkUrl) {
    if (statusEl) statusEl.textContent = '⏳ Téléchargement…';
    try {
      await UP.downloadAndInstall({ url: apkUrl });
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/permission/i.test(msg)) {
        alert("Autorise « Installer des applis inconnues » pour Bornes VE dans les réglages Android, puis réessaie.");
      } else {
        alert('Échec de la mise à jour : ' + msg);
      }
      if (onEnd) onEnd();
    }
    return;
  }
  window.open(apkUrl, '_blank');  // PWA / pas de plugin : téléchargement navigateur
  if (onEnd) onEnd();
}
window.installApkUpdate = installApkUpdate;  // utilisé aussi par update-check.js
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
      installApkUpdate(apk ? apk.browser_download_url : rel.html_url, st);
    } else {
      st.innerHTML = ' · <span style="color:#22c55e">à jour ✅</span>';
    }
  } catch (e) { st.textContent = ' · échec de la vérification (hors ligne ?)'; }
}

// ---------- ChargePrice : prix réels multi-opérateurs (clé API démo requise) ----------
const CP_BASE_DEFAULT = 'https://api.chargeprice.app';
function cpKey() { try { return (localStorage.getItem('cpKey') || '').trim(); } catch (e) { return ''; } }
function cpBase() { try { return (localStorage.getItem('cpBase') || CP_BASE_DEFAULT).trim() || CP_BASE_DEFAULT; } catch (e) { return CP_BASE_DEFAULT; } }
// URL de l'endpoint, robuste quelle que soit la base saisie (⚠️ PAS de slash final
// sinon 404) : gère base nue, base finissant par /v1, ou déjà /charge_prices.
function cpUrl() {
  let b = cpBase().replace(/\/+$/, '');
  // insights.chargeprice.app = tableau de bord web (pas l'API) → host API réel.
  b = b.replace(/insights\.chargeprice\.app/i, 'api.chargeprice.app');
  if (/\/charge_prices$/i.test(b)) return b;
  if (/\/v\d+$/i.test(b)) return b + '/charge_prices';
  return b + '/v1/charge_prices';
}
const CP_PLUG = { 'Type 2': 'type2', 'CCS Combo': 'ccs', 'CHAdeMO': 'chademo', 'Type E/F': 'schuko' };
function cpChargePoints(s) {
  const pts = [], seen = new Set();
  (s.connectors || []).forEach(c => { const p = CP_PLUG[c]; if (p && !seen.has(p)) { seen.add(p); pts.push({ power: num(s.puissance) || 22, plug: p }); } });
  if (!pts.length) pts.push({ power: num(s.puissance) || 22, plug: 'type2' });
  return pts;
}
async function cpFetch(s) {
  if (!cpKey()) throw new Error('no-key');
  const body = { data: { type: 'charge_price_request', attributes: {
    data_adapter: 'chargeprice',
    station: { longitude: num(s.lon), latitude: num(s.lat), country: 'FR', charge_points: cpChargePoints(s) },
    options: { energy: 30, duration: 30, currency: 'EUR', start_time: 720 },
  } } };
  const url = cpUrl();
  const headers = { 'API-Key': cpKey(), 'Content-Type': 'application/json', 'Accept-Language': 'fr' };
  let json;
  const HTTP = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  if (HTTP) {   // natif : contourne le CORS (l'API ChargePrice n'ouvre pas le CORS navigateur)
    const r = await HTTP.post({ url, headers, data: body, connectTimeout: 12000, readTimeout: 20000 });
    if (r.status && r.status >= 400) throw new Error('HTTP ' + r.status);
    json = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  } else {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    json = await r.json();
  }
  return (json.data || []).map(d => {
    const a = d.attributes || {}, cpp = (a.charge_point_prices || [])[0] || {};
    return { provider: a.provider || '?', tariff: a.tariff_name || '', price: cpp.price, currency: a.currency || 'EUR' };
  }).filter(x => isFinite(x.price)).sort((a, b) => a.price - b.price);
}
function stationById(id) {
  const it = myStations.find(m => m.id === id);
  if (it) return it.snap;
  return (currentStations || []).find(x => x.id === id) || null;
}
async function openChargePrice(id) {
  const s = stationById(id);
  if (!s) return;
  if (!cpKey()) { alert('Ajoute ta clé ChargePrice dans l’onglet ℹ️ Infos pour voir les prix réels.'); return; }
  el('cpTitle').textContent = s.nom || 'Prix réels';
  el('cpList').innerHTML = '<p class="cp-note">⏳ Récupération des tarifs…</p>';
  el('cpModal').hidden = false;
  try {
    const rows = await cpFetch(s);
    if (!rows.length) { el('cpList').innerHTML = '<p class="cp-note">Aucun tarif renvoyé (données démo limitées pour cette borne).</p>'; return; }
    el('cpList').innerHTML = rows.slice(0, 25).map((r, i) =>
      `<div class="cp-row${i === 0 ? ' best' : ''}">
        <div><div class="cp-prov">${i === 0 ? '⭐ ' : ''}${esc(r.provider)}</div><div class="cp-tar">${esc(r.tariff)}</div></div>
        <div class="cp-price">${r.price.toFixed(2)} ${esc(r.currency)}</div>
      </div>`).join('');
  } catch (e) {
    const m = (e && e.message) || String(e);
    let hint;
    if (m === 'no-key') hint = 'Clé manquante.';
    else if (/404/.test(m)) hint = 'Base URL incorrecte. Laisse simplement <b>https://api.chargeprice.app</b> (sans /v1 ni slash final) dans ℹ️ Infos.';
    else if (/401|403/.test(m)) hint = 'Clé refusée. Vérifie la clé démo collée dans ℹ️ Infos.';
    else hint = 'Échec (' + esc(m) + '). Vérifie clé et base URL. En navigateur le CORS peut bloquer — utilise l’APK.';
    el('cpList').innerHTML = '<p class="cp-note">⚠️ ' + hint + '</p>';
  }
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
  renderMine();
  el('searchBtn').onclick = doSearch;
  el('communeInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  el('geoBtn').onclick = geolocate;
  el('powerFilter').onchange = renderResults;
  el('radiusFilter').onchange = () => { if (geoSort && userPos) loadAround(); else renderResults(); };
  el('sortMine').onchange = renderMine;
  el('refreshAll').onclick = refreshAll;
  el('appVersion').textContent = 'v' + (window.APP_VERSION || '?');
  el('verChip').textContent = 'v' + (window.APP_VERSION || '?');
  el('checkUpdBtn').onclick = checkUpdate;
  el('pmCancel').onclick = closePrice;
  el('pmSave').onclick = savePrice;
  el('priceModal').addEventListener('click', e => { if (e.target === el('priceModal')) closePrice(); });

  // ChargePrice (prix réels) : clé + base + modale
  el('cpKeyInput').value = cpKey();
  try { el('cpBaseInput').value = localStorage.getItem('cpBase') || ''; } catch (e) {}
  el('cpSaveBtn').onclick = () => {
    try {
      localStorage.setItem('cpKey', el('cpKeyInput').value.trim());
      const b = el('cpBaseInput').value.trim();
      if (b) localStorage.setItem('cpBase', b); else localStorage.removeItem('cpBase');
    } catch (e) {}
    el('cpSaveState').textContent = ' ✅ enregistré';
    renderMine();
    if (searchRaw.length) renderResults();
  };
  el('cpClose').onclick = () => { el('cpModal').hidden = true; };
  el('cpModal').addEventListener('click', e => { if (e.target === el('cpModal')) el('cpModal').hidden = true; });

  // menu déroulant multichoix fournisseurs
  el('opDropBtn').onclick = e => { e.stopPropagation(); el('opDropPanel').hidden = !el('opDropPanel').hidden; };
  el('opSearch').oninput = filterOpList;
  el('opClear').onclick = () => {
    activeOps.clear();
    el('opList').querySelectorAll('input').forEach(cb => { cb.checked = false; });
    updateOpBtn();
    renderResults();
  };
  // Fermer le menu si clic hors de .ms (garde-fou si la cible est détachée du DOM).
  document.addEventListener('click', e => {
    if (el('opDropPanel').hidden) return;
    const t = e.target;
    if (t && t.isConnected && t.closest && t.closest('.ms')) return;
    el('opDropPanel').hidden = true;
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  ensurePosition();   // kilométrage sur toutes les cartes dès le départ
}
document.addEventListener('DOMContentLoaded', init);
