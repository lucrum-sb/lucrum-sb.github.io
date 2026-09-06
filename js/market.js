// Market browser – every product in GET /snapshot, filterable and sortable.
//
// This page exists because ~2000 tracked products were previously unreachable from the UI: the
// only route to an item page was clicking a signal row. Nothing here computes a market figure
// (CLAUDE.md hard rule 2) – it sorts, filters and formats the fields the snapshot returns.
import { loadSnapshot } from './catalog.js';
import { renderErrorState, classifyFailure } from './errors.js';
import { mountStatusStrip, itemHref } from './shell.js';
import {
  formatCoins, formatCompact, formatPctSigned, formatInt, itemLabel, esc, signClass,
} from './format.js';

const slot = document.getElementById('market-slot');
const searchInput = document.getElementById('market-search');
const countEl = document.getElementById('result-count');
const filterTabs = document.querySelectorAll('#market-filters .tab');

const PAGE = 100;

const COLUMNS = [
  { key: 'id', label: 'Item', num: false },
  { key: 'instantBuy', label: 'Instant buy', num: true, cls: 'buy-c', fmt: formatCoins },
  { key: 'instantSell', label: 'Instant sell', num: true, cls: 'sell-c', fmt: formatCoins },
  { key: 'bestBuyOrder', label: 'Best order', num: true, fmt: formatCoins },
  { key: 'bestSellOffer', label: 'Best offer', num: true, fmt: formatCoins },
  { key: 'spread', label: 'Spread', num: true, fmt: formatCoins, signed: true },
  { key: 'spreadPct', label: 'Spread %', num: true, fmt: (v) => formatPctSigned(v, 2), signed: true },
  { key: 'buyVolume', label: 'Buy depth', num: true, fmt: formatCompact },
  { key: 'sellVolume', label: 'Sell depth', num: true, fmt: formatCompact },
  { key: 'buyMovingWeek', label: 'Bought / wk', num: true, fmt: formatCompact },
  { key: 'sellMovingWeek', label: 'Sold / wk', num: true, fmt: formatCompact },
];

let rows = [];
let view = [];
let shown = PAGE;
let sortKey = 'sellMovingWeek';
let sortDir = -1;
let query = '';
let minWeekly = 0;

function normalise(s) {
  return s.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function applyFilters() {
  const q = normalise(query);
  view = rows.filter((r) => {
    if (minWeekly && !(r.buyMovingWeek >= minWeekly || r.sellMovingWeek >= minWeekly)) return false;
    return !q || r.id.includes(q);
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

  if (view.length === 0) {
    slot.innerHTML = `<p class="empty-state">No product matches ${query ? `“${esc(query)}”` : 'this filter'}.</p>`;
    return;
  }

  const head = COLUMNS.map((c) => {
    const sorted = c.key === sortKey;
    return `<th class="${c.num ? 'num ' : ''}sortable" data-key="${c.key}"${
      sorted ? ` aria-sort="${sortDir === -1 ? 'descending' : 'ascending'}"` : ''
    }>${c.label}<span class="arrow">${sorted && sortDir === 1 ? '↑' : '↓'}</span></th>`;
  }).join('');

  const body = view.slice(0, shown).map((r) => {
    const cells = COLUMNS.slice(1).map((c) => {
      const v = r[c.key];
      const cls = c.signed ? signClass(v) : (c.cls || '');
      return `<td class="num ${cls}">${c.fmt(v)}</td>`;
    }).join('');
    return `<tr>
      <td class="key"><a href="${itemHref(r.id)}">${esc(itemLabel(r.id))}</a>
        <span class="why-line">${esc(r.id)}</span></td>
      ${cells}
    </tr>`;
  }).join('');

  slot.innerHTML = `
    <div class="table-wrap"><div class="table-scroll">
      <table class="ledger dense"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    </div></div>
    ${view.length > shown ? `<div class="load-more"><button class="btn" id="more-btn" type="button">Show ${formatInt(Math.min(PAGE, view.length - shown))} more</button></div>` : ''}
    <p class="dimmer" style="font-size:0.75rem;margin-top:0.6rem">
      Spread is the worker's own <span class="mono">bestSellOffer − bestBuyOrder</span>, the
      top-of-book gap a patient order pair captures – not the wider quick-quote gap between instant
      buy and instant sell. It is not recomputed here. Depth is the coins-worth resting on each
      side; orders and offers are how many of them there are; bought and sold per week are the
      moving-week totals. The count of resting orders and offers behind each depth figure is on
      the item's own page, one click away, rather than a column here.
    </p>
  `;

  slot.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (key === sortKey) sortDir = -sortDir;
      else { sortKey = key; sortDir = key === 'id' ? 1 : -1; }
      applyFilters();
    });
  });

  const more = document.getElementById('more-btn');
  if (more) more.addEventListener('click', () => { shown += PAGE; render(); });
}

filterTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    filterTabs.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    minWeekly = btn.dataset.filter === '10k' ? 10000 : btn.dataset.filter === '1m' ? 1000000 : 0;
    applyFilters();
  });
});

let debounce = null;
searchInput.addEventListener('input', () => {
  query = searchInput.value;
  clearTimeout(debounce);
  debounce = setTimeout(applyFilters, 90);
});

const strip = mountStatusStrip(document.getElementById('status-strip'));

loadSnapshot().then((snap) => {
  const products = snap.products || {};
  rows = Object.keys(products).map((id) => ({ id, ...products[id] }));
  strip.update({ taxRate: snap.taxRate, mayor: snap.mayor });
  applyFilters();
}).catch((err) => {
  renderErrorState(slot, classifyFailure(err, err.body) || 'unreachable');
  countEl.textContent = '';
});
