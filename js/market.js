// Market browser – every product in GET /market, screened by what it actually earns per order
// slot. Nothing here computes a market figure (CLAUDE.md hard rule 2): the worker returns net per
// unit, net per slot-hour, full-order cost and the rest (quant/market.js); this page thresholds,
// sorts and formats them.
//
// Why the default view is "Worth a slot" and not "everything by volume": one bazaar order carries
// at most 71,680 units, so a 40% margin on a 2-coin item earns about what 0.4% does on a
// 2,000-coin one – while tying up a slot for hours. A list ranked by margin or volume puts exactly
// those trades on top. Net per slot-hour is the number that does not.
import { callWorker, WorkerUnreachableError } from './api.js';
import { renderErrorState, classifyFailure } from './errors.js';
import { mountStatusStrip, itemHref } from './shell.js';
import {
  formatCoins, formatCompact, formatPctSigned, formatInt, itemLabel, esc, signClass,
} from './format.js';
import { getSettings, mountSettingsBar, onSettingsChange, parseCoins, formatCoinsShort } from './settings.js';

const slot = document.getElementById('market-slot');
const searchInput = document.getElementById('market-search');
const countEl = document.getElementById('result-count');
const viewTabs = document.querySelectorAll('#market-views .tab');
const minPriceInput = document.getElementById('f-min-price');
const minSlotInput = document.getElementById('f-min-slot');
const maxRiskSelect = document.getElementById('f-max-risk');
const affordableBox = document.getElementById('f-affordable');

const PAGE = 100;
const PREF_KEY = 'lucrum-market-view';

/** Net per slot-hour a "worth a slot" row must clear. 100k an hour per order is the bottom of
 * what a flipper with 14 slots would bother with; the filter box overrides it. */
const WORTH_A_SLOT = 100_000;

const VIEWS = {
  worth: {
    label: 'Worth a slot',
    sort: 'riskAdjustedNetPerSlotHour',
    test: (r, f) => r.netPerUnit > 0 && r.riskAdjustedNetPerSlotHour >= (f.minSlot ?? WORTH_A_SLOT),
    note: `Flips earning at least ${formatCompact(WORTH_A_SLOT)} per order-slot hour after tax, once discounted for manipulation risk and margins too wide to be real. Cheap items rarely make it: one order holds at most 71,680 units.`,
  },
  flips: {
    label: 'All flips',
    sort: 'riskAdjustedNetPerSlotHour',
    test: (r) => r.netPerUnit > 0,
    note: 'Every item where a buy order and a sell offer one tick inside the book clear tax.',
  },
  npc: {
    label: 'NPC sells',
    sort: 'npcMarginPct',
    test: (r) => r.npcMarginPct !== null && r.npcMarginPct >= 0.005,
    note: 'Buy orders under the price an NPC pays. No tax on NPC sales, but they pass through your inventory 2,240 at a time and NPC sales are capped per day.',
  },
  all: {
    label: 'All products',
    sort: 'instantSellsPerHour',
    test: () => true,
    note: 'Every product in the latest snapshot.',
  },
};

const COLUMNS = [
  { key: 'id', label: 'Item', num: false },
  { key: 'buyOrderPrice', label: 'Buy order', cls: 'buy-c', fmt: formatCoins, title: 'Where a patient buy order stands: one tick over the best bid, or over the recent typical bid when the book has a momentary hole.' },
  { key: 'sellOfferPrice', label: 'Sell offer', cls: 'sell-c', fmt: formatCoins, title: 'Where a patient sell offer stands: one tick under the best ask, or under the recent typical ask.' },
  { key: 'netPerUnit', label: 'Net / unit', fmt: formatCoins, signed: true, title: 'Sell offer after tax, minus the buy order.' },
  { key: 'marginPct', label: 'Margin', fmt: (v) => formatPctSigned(v, 1), signed: true },
  { key: 'riskAdjustedNetPerSlotHour', label: 'Net / slot-hour', fmt: formatCompact, accent: true, title: 'What one order slot earns in an hour of flipping this item – net per unit times what one order can move in an hour (25% of the thinner side\'s flow, capped at 71,680) – discounted for manipulation risk and implausibly wide margins.' },
  { key: 'netPerSlotHour', label: 'Undiscounted', fmt: formatCompact, title: 'Net per slot-hour before the risk discount.' },
  { key: 'unitsPerHourOrder', label: 'Units / h', fmt: (v) => (v === null || v === undefined ? '–' : v < 10 ? v.toFixed(1) : formatCompact(v)), title: 'Units one order can expect to move in an hour. Under 1 means a single unit takes longer than an hour – expensive items fill rarely, and each fill is lumpy.' },
  { key: 'hourOrderCoins', label: 'Hour\'s order', fmt: formatCompact, title: 'What that hour\'s order costs to place.' },
  { key: 'npcMarginPct', label: 'NPC', fmt: (v) => (v === null || v === undefined ? '–' : formatPctSigned(v, 1)), signed: true, title: 'NPC sell price over the buy order. Untaxed; capped per day.' },
  { key: 'instantSellsPerHour', label: 'Sold / h', fmt: formatCompact, title: 'Units instant-sold per hour – the flow that fills buy orders.' },
  { key: 'instantBuysPerHour', label: 'Bought / h', fmt: formatCompact, title: 'Units instant-bought per hour – the flow that fills sell offers.' },
  { key: 'manipulationRisk', label: 'Risk', fmt: (v) => (v === null || v === undefined ? '–' : v.toFixed(2)), asc: true, title: '0–1 manipulation risk: walls, spreads with no volume, sell offers far above their three-day range.' },
];

let rows = [];
let view = [];
let shown = PAGE;
let viewKey = 'worth';
let sortKey = VIEWS.worth.sort;
let sortDir = -1;
let query = '';
const filters = { minPrice: null, minSlot: null, maxRisk: null, affordable: false };

try {
  const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
  if (VIEWS[saved.view]) { viewKey = saved.view; sortKey = VIEWS[viewKey].sort; }
} catch (err) { /* defaults */ }
const urlView = new URLSearchParams(location.search).get('view');
if (VIEWS[urlView]) { viewKey = urlView; sortKey = VIEWS[viewKey].sort; }

function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify({ view: viewKey })); } catch (err) { /* ok */ }
}

function normalise(s) {
  return s.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function applyFilters() {
  const q = normalise(query);
  const capital = getSettings().capital;
  const test = VIEWS[viewKey].test;
  view = rows.filter((r) => {
    if (q && !r.id.includes(q)) return false;
    if (!test(r, filters)) return false;
    if (filters.minPrice && !(r.buyOrderPrice >= filters.minPrice)) return false;
    if (filters.minSlot && viewKey !== 'worth' && !(r.riskAdjustedNetPerSlotHour >= filters.minSlot)) return false;
    if (filters.maxRisk !== null && !(r.manipulationRisk <= filters.maxRisk)) return false;
    // "Fits my capital": an hour's worth of the order (the size every column is quoted at) is
    // fundable – a threshold on the worker's own hourOrderCoins.
    if (filters.affordable && capital > 0 && !(r.hourOrderCoins <= capital)) return false;
    return true;
  });
  view.sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (sortKey === 'id') return av.localeCompare(bv) * sortDir;
    return ((av ?? -Infinity) - (bv ?? -Infinity)) * sortDir;
  });
  shown = PAGE;
  render();
}

function render() {
  countEl.textContent = `${formatInt(view.length)} of ${formatInt(rows.length)} products`;
  const note = `<p class="view-note dim">${esc(VIEWS[viewKey].note)}</p>`;

  if (view.length === 0) {
    slot.innerHTML = `${note}<p class="empty-state">No product matches ${query ? `“${esc(query)}”` : 'these filters'}.</p>`;
    return;
  }

  const head = COLUMNS.map((c) => {
    const sorted = c.key === sortKey;
    return `<th class="${c.key !== 'id' ? 'num ' : ''}sortable" data-key="${c.key}"${c.title ? ` title="${esc(c.title)}"` : ''}${
      sorted ? ` aria-sort="${sortDir === -1 ? 'descending' : 'ascending'}"` : ''
    }>${c.label}<span class="arrow">${sorted && sortDir === 1 ? '↑' : '↓'}</span></th>`;
  }).join('');

  const body = view.slice(0, shown).map((r) => {
    const cells = COLUMNS.slice(1).map((c) => {
      const v = r[c.key];
      const cls = c.signed ? signClass(v) : (c.cls || '');
      return `<td class="num ${cls}${c.accent ? ' strong' : ''}">${c.fmt(v)}</td>`;
    }).join('');
    const flags = [];
    if (r.repriced) flags.push('book has a momentary hole – priced off the recent typical level');
    if (r.manipulationRisk >= 0.3) flags.push('elevated manipulation risk');
    return `<tr>
      <td class="key"><a href="${itemHref(r.id)}">${esc(itemLabel(r.id))}</a>
        <span class="why-line">${esc(r.id)}${flags.length ? ` · ${esc(flags.join(' · '))}` : ''}</span></td>
      ${cells}
    </tr>`;
  }).join('');

  slot.innerHTML = `
    ${note}
    <div class="table-wrap"><div class="table-scroll">
      <table class="ledger dense"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    </div></div>
    ${view.length > shown ? `<div class="load-more"><button class="btn" id="more-btn" type="button">Show ${formatInt(Math.min(PAGE, view.length - shown))} more</button></div>` : ''}
    <p class="dimmer" style="font-size:0.75rem;margin-top:0.6rem">
      Every figure is the worker's own, for a plain flip one tick inside the book with tax at your
      Bazaar Flipper level – a screen, not a recommendation. Hover a column header for what it
      means. For theses, hold times and fill odds, see <a href="../signals/">Signals</a>; to fill
      your order slots with the best mix for your capital, see <a href="../plan/">Plan</a>.
    </p>
  `;

  slot.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      const col = COLUMNS.find((c) => c.key === key);
      if (key === sortKey) sortDir = -sortDir;
      else { sortKey = key; sortDir = key === 'id' || col?.asc ? 1 : -1; }
      applyFilters();
    });
  });

  const more = document.getElementById('more-btn');
  if (more) more.addEventListener('click', () => { shown += PAGE; render(); });
}

function syncTabs() {
  viewTabs.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === viewKey)));
}

viewTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    viewKey = btn.dataset.view;
    sortKey = VIEWS[viewKey].sort;
    sortDir = -1;
    syncTabs();
    savePrefs();
    applyFilters();
  });
});

let debounce = null;
searchInput.addEventListener('input', () => {
  query = searchInput.value;
  clearTimeout(debounce);
  debounce = setTimeout(applyFilters, 90);
});

function readCoinsInput(input) {
  if (input.value.trim() === '') { input.removeAttribute('aria-invalid'); return null; }
  const v = parseCoins(input.value);
  if (v === null) { input.setAttribute('aria-invalid', 'true'); return undefined; }
  input.removeAttribute('aria-invalid');
  return v;
}
minPriceInput.addEventListener('change', () => {
  const v = readCoinsInput(minPriceInput);
  if (v !== undefined) { filters.minPrice = v; applyFilters(); }
});
minSlotInput.addEventListener('change', () => {
  const v = readCoinsInput(minSlotInput);
  if (v !== undefined) { filters.minSlot = v; applyFilters(); }
});
maxRiskSelect.addEventListener('change', () => {
  filters.maxRisk = maxRiskSelect.value === '' ? null : Number(maxRiskSelect.value);
  applyFilters();
});
affordableBox.addEventListener('change', () => { filters.affordable = affordableBox.checked; applyFilters(); });

const strip = mountStatusStrip(document.getElementById('status-strip'));
mountSettingsBar(document.getElementById('settings-bar'));
syncTabs();

async function load() {
  const { flipper } = getSettings();
  slot.innerHTML = '<p class="loading-state">Loading the market&hellip;</p>';
  try {
    const { status, body } = await callWorker(`/market?flipper=${flipper}`);
    if (status !== 200) {
      renderErrorState(slot, classifyFailure(null, body) || 'unknown', { what: 'The market screen' });
      countEl.textContent = '';
      return;
    }
    const items = body.items || {};
    rows = Object.keys(items).map((id) => ({ id, ...items[id] }));
    strip.update({ taxRate: body.taxRate, mayor: body.mayor });
    applyFilters();
  } catch (err) {
    renderErrorState(slot, err instanceof WorkerUnreachableError ? 'unreachable' : 'unknown', { what: 'The market screen' });
    countEl.textContent = '';
  }
}

let lastFlipper = getSettings().flipper;
onSettingsChange((s) => {
  if (s.flipper !== lastFlipper) { lastFlipper = s.flipper; load(); }
  else applyFilters(); // capital only changes the "affordable" filter
});

load();

function describeAffordable() {
  const cap = getSettings().capital;
  affordableBox.parentElement.title = cap > 0
    ? `Hide items where an hour's order costs more than ${formatCoinsShort(cap)}.`
    : 'Set your capital above to use this filter.';
  affordableBox.disabled = !(cap > 0);
}
describeAffordable();
onSettingsChange(describeAffordable);
