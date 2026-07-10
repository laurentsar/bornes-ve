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
let editingId = null;             // borne en cours d'édition de prix

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

// Connecteurs présents sur un point de charge -> liste de labels.
function connectorsOf(row) {
  return CONNECTORS.filter(c => truthy(row[c.key])).map(c => c.label);
}

// Regroupe des points de charge (rows) en STATIONS par id_station_itinerance.
function groupStations(rows) {
  const map = new Map();
  for (const r of rows) {
    const id = r.id_station_itinerance || r.id_station_local ||
               (r.nom_station + '|' + r.adresse_station);
    let s = map.get(id);
    if (!s) {
      s = {
        id,
        nom: r.nom_station || r.nom_enseigne || 'Station',
        operateur: r.nom_operateur || r.nom_enseigne || r.nom_amenageur || '—',
        adresse: r.adresse_station || '',
        commune: r.consolidated_commune || '',
        lat: r.consolidated_latitude, lon: r.consolidated_longitude,
        puissance: 0, connectors: new Set(), pdc: 0,
        gratuit: truthy(r.gratuit), cb: truthy(r.paiement_cb),
        tarification: r.tarification || '', horaires: r.horaires || '',
        maj: r.date_maj || r.last_modified || '',
      };
      map.set(id, s);
    }
    s.pdc += 1;
    s.puissance = Math.max(s.puissance, num(r.puissance_nominale));
    connectorsOf(r).forEach(c => s.connectors.add(c));
    if (truthy(r.gratuit)) s.gratuit = true;
    if (truthy(r.paiement_cb)) s.cb = true;
    if (!s.tarification && r.tarification) s.tarification = r.tarification;
    if (!s.horaires && r.horaires) s.horaires = r.horaires;
  }
  return [...map.values()].map(s => ({ ...s, connectors: [...s.connectors] }));
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
function fetchByStationId(id) {
  return fetchRows('id_station_itinerance__exact=' + encodeURIComponent(id), 1);
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
function fillOperatorFilter(stations) {
  const ops = [...new Set(stations.map(s => s.operateur).filter(Boolean))].sort();
  const sel = el('operatorFilter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Tous</option>' +
    ops.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  if (ops.includes(cur)) sel.value = cur;
}

// ---------- rendu : recherche ----------
function renderSearch() {
  const stations = groupStations(searchRaw);
  fillOperatorFilter(stations);
  const op = el('operatorFilter').value;
  const minPow = num(el('powerFilter').value);

  const filtered = stations.filter(s => {
    if (op && s.operateur !== op) return false;
    if (minPow && s.puissance < minPow) return false;
    if (activeTypes.size && !s.connectors.some(c => activeTypes.has(c))) return false;
    return true;
  });

  el('searchStatus').textContent = searchRaw.length
    ? `${filtered.length} station(s) · ${searchRaw.length} points de charge trouvés`
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
  if (s.puissance) badges.push(`<span class="badge pow">${s.puissance} kW</span>`);
  if (s.pdc) badges.push(`<span class="badge">${s.pdc} pdc</span>`);
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
      <div style="min-width:0">
        <p class="card-name">${esc(s.nom)}</p>
        <p class="card-op">⚡ ${esc(s.operateur)}</p>
        <p class="card-addr">📍 ${esc(s.adresse)}</p>
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
    id: s.id, nom: s.nom, operateur: s.operateur, adresse: s.adresse, commune: s.commune,
    lat: s.lat, lon: s.lon, puissance: s.puissance, pdc: s.pdc, connectors: s.connectors,
    gratuit: s.gratuit, cb: s.cb, tarification: s.tarification, horaires: s.horaires, maj: s.maj,
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
      const rows = await fetchByStationId(it.id);
      if (rows.length) { it.snap = snapOf(groupStations(rows)[0]); ok++; }
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
  const commune = el('communeInput').value.trim();
  if (!commune) { el('searchStatus').textContent = 'Entre une commune.'; return; }
  el('searchStatus').innerHTML = '<span class="spin">⏳</span> Recherche officielle…';
  el('searchList').innerHTML = '';
  try {
    searchRaw = await fetchByCommune(commune);
    renderSearch();
    if (!searchRaw.length) el('searchStatus').textContent = 'Aucune borne trouvée pour « ' + commune + ' ».';
  } catch (e) {
    el('searchStatus').textContent = '⚠️ Erreur réseau (' + e.message + '). Réessaie.';
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
  el('operatorFilter').onchange = renderSearch;
  el('powerFilter').onchange = renderSearch;
  el('sortMine').onchange = renderMine;
  el('refreshAll').onclick = refreshAll;
  el('pmCancel').onclick = closePrice;
  el('pmSave').onclick = savePrice;
  el('priceModal').addEventListener('click', e => { if (e.target === el('priceModal')) closePrice(); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
document.addEventListener('DOMContentLoaded', init);
