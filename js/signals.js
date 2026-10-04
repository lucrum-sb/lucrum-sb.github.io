// Signal browser – docs/CONTRACTS.md's GET /signals. No ranking or scoring logic here
// (CLAUDE.md hard rule 2): the worker returns `score`, this page sorts the array it was given.
//
// Every field the contract defines is reachable: the load-bearing ones in the row, the rest in
// the expandable detail panel, per docs/BRAND.md ("nothing the worker returns is dropped").
import { callWorker, WorkerUnreachableError } from './api.js';
import { renderErrorState, classifyFailure, failureText } from './errors.js';
import { mountStatusStrip, itemHref } from './shell.js';
import {
  formatCoins, formatCoinsPrecise, formatPct, formatPctSigned, formatInt, formatCompact,
  formatHoldDays, formatFillMinutes, methodLabel, itemLabel, esc, signClass,
} from './format.js';
import { getSettings, mountSettingsBar, onSettingsChange } from './settings.js';

const TYPES = ['position', 'spread', 'craft', 'event', 'npc'];

/** Factor names as a reader would say them – the keys are docs/CONTRACTS.md's `factors`. */
const FACTOR_LABEL = {
  margin: 'Margin after tax',
  plausible: 'Margin plausibility',
  fill: 'Both legs fill',
  liquid: 'Liquidity',
  clean: 'No manipulation',
  scale: 'Earnings per order / slot',
  effort: 'Earnings per hour of clicking',
  capacity: 'Market throughput',
  capital: 'Capital turnover',
  patience: 'Hold length',
  conviction: 'Measured, not guessed',
};
const heroSlot = document.getElementById('hero-slot');
const tableSlot = document.getElementById('table-slot');
const tabs = document.querySelectorAll('#type-tabs .tab');

/** type -> { signals, taxRate, generatedAt } or { failure: kind } */
const byType = {};
let activeType = 'position';
let sortKey = 'score';
let sortDir = -1;
let strip = null;

/* --- Field renderers -------------------------------------------------------------------------- */

function fittedCaveat(signal) {
  // docs/CONTRACTS.md: a false `fitted` flag must be stated in plain words, not merely flagged.
  if (signal.fitted === false) {
    return 'Magnitude is a conservative placeholder from the event registry, not a value measured from stored history.';
  }
  return null;
}

function legCell(leg) {
  if (!leg) return '–';
  return `${formatCoins(leg.price)}<span class="why-line">${esc(methodLabel(leg.method))} · ${formatPct(leg.fillProbability, 0)} fill · ${esc(formatFillMinutes(leg.estFillMinutes))}</span>`;
}

/** manipulationRisk and liquidityScore are both 0–1 but read in opposite directions, so each gets
 * a bar whose colour states which way is good rather than leaving the reader to remember. */
function riskBar(value, goodIsHigh) {
  if (value === null || value === undefined) return '–';
  const good = goodIsHigh ? value >= 0.6 : value <= 0.2;
  const bad = goodIsHigh ? value < 0.3 : value > 0.5;
  const cls = good ? 'is-good' : bad ? 'is-bad' : '';
  return `<span class="risk-bar ${cls}"><span style="width:${Math.round(value * 100)}%"></span></span>${value.toFixed(2)}`;
}

function craftSteps(signal) {
  if (!signal.steps || !signal.steps.length) return '';
  const rows = signal.steps.map((s, i) => `
    <li class="${i === signal.bottleneckStep ? 'bottleneck' : ''}">
      <span class="step-n">${i + 1}</span>
      <span>${formatInt(s.inputQty)} × <a href="${itemHref(s.input)}">${esc(itemLabel(s.input))}</a>
        &rarr; ${formatInt(s.outputQty)} × <a href="${itemHref(s.output)}">${esc(itemLabel(s.output))}</a></span>
      <span class="dimmer num">${formatCoins(s.costPerOutput)} / output · ${formatCompact(s.throughputPerHour)}/h</span>
      ${i === signal.bottleneckStep ? '<span class="dimmer">bottleneck</span>' : ''}
    </li>`).join('');
  return `
    <div class="detail-section">
      <span class="label">Craft path</span>
      <ul class="craft-steps">${rows}</ul>
      <p class="dim" style="margin:0.6rem 0 0;font-size:0.8rem">
        Sustainable throughput <span class="num">${formatCompact(signal.maxHourlyThroughput)}</span> per hour,
        set by the slowest step's order-book depth.
      </p>
    </div>`;
}

const BINDING_LABEL = {
  flow: 'market flow in the patience window',
  capital: 'your capital',
  'order-cap': 'the order cap',
  throughput: 'craft throughput',
  'npc-cap': 'the daily NPC sell cap',
};

/** One bar per score factor, so the ranking explains itself. The worker computes every value. */
function factorBars(signal) {
  const f = signal.factors;
  if (!f) return '';
  const rows = Object.entries(f).map(([key, v]) => `
    <span class="dim">${esc(FACTOR_LABEL[key] || key)}</span>
    <span class="bar${v < 0.35 ? ' is-low' : ''}"><span style="width:${Math.round(Math.max(0, Math.min(1, v)) * 100)}%"></span></span>
    <span class="num">${v.toFixed(2)}</span>`).join('');
  return `
    <div class="detail-section">
      <span class="label">Score breakdown – the score is the product of these</span>
      <div class="factor-bars">${rows}</div>
    </div>`;
}

function detailPanel(signal, meta) {
  const caveat = fittedCaveat(signal);
  const fields = [];
  const push = (label, value) => fields.push(`<div><span class="label">${label}</span><span class="value">${value}</span></div>`);

  if (signal.direction) push('Direction', esc(signal.direction));
  push('Gross / unit', formatCoinsPrecise(signal.grossPerUnit));
  push('Net / unit', formatCoinsPrecise(signal.netPerUnit));
  push('Tax at scoring', meta.taxRate === undefined ? '–' : formatPct(meta.taxRate, 2));
  push('Suggested qty', formatInt(signal.suggestedQty));
  const cap = signal.capacity;
  if (cap) {
    push('Orders', `${formatInt(cap.orders)}${cap.sellOffers ? ` + ${formatInt(cap.sellOffers)} sell offer${cap.sellOffers === 1 ? '' : 's'}` : ''} · ${formatInt(cap.unitsPerOrder)} / order`);
    push('Capital tied up', formatCoins(cap.capital));
    push('Net at qty', formatCoins(cap.net));
    push('Net / order', formatCoins(cap.netPerOrder));
    push('Net / slot-hour', cap.netPerSlotHour === null ? '–' : formatCoins(cap.netPerSlotHour));
    push('Hands-on time', `${cap.activeMinutes} min · ${cap.netPerActiveHour === null ? '–' : `${formatCompact(cap.netPerActiveHour)} / hour`}`);
    push('Sized by', esc(BINDING_LABEL[cap.binding] || cap.binding));
  }
  if (signal.holdDays) push('Hold', esc(formatHoldDays(signal.holdDays)));
  push('Liquidity', riskBar(signal.liquidityScore, true));
  push('Manipulation risk', riskBar(signal.manipulationRisk, false));
  push('Entry', `${formatCoins(signal.entry && signal.entry.price)} · ${esc(methodLabel(signal.entry && signal.entry.method))}`);
  push('Entry fill', signal.entry ? `${formatPct(signal.entry.fillProbability, 0)} · ${esc(formatFillMinutes(signal.entry.estFillMinutes))}` : '–');
  push('Exit', `${formatCoins(signal.exit && signal.exit.price)} · ${esc(methodLabel(signal.exit && signal.exit.method))}`);
  push('Exit fill', signal.exit ? `${formatPct(signal.exit.fillProbability, 0)} · ${esc(formatFillMinutes(signal.exit.estFillMinutes))}` : '–');

  return `
    ${signal.thesis ? `<p style="margin:0 0 0.9rem;max-width:78ch">${esc(signal.thesis)}</p>` : ''}
    <div class="detail-grid">${fields.join('')}</div>
    ${craftSteps(signal)}
    ${factorBars(signal)}
    ${caveat ? `<p class="caveat">${esc(caveat)}</p>` : ''}
    <p style="margin:0.9rem 0 0"><a href="${itemHref(signal.item)}">Chart, prediction and model check for ${esc(itemLabel(signal.item))} &rarr;</a></p>
  `;
}

/* --- Hero ------------------------------------------------------------------------------------- */

function renderHero() {
  let best = null;
  let bestMeta = null;
  for (const t of TYPES) {
    const entry = byType[t];
    if (!entry || entry.failure) continue;
    for (const s of entry.signals) {
      if (!best || s.score > best.score) { best = s; bestMeta = entry; }
    }
  }
  heroSlot.innerHTML = '';
  if (!best) {
    const anyReachable = TYPES.some((t) => byType[t] && !byType[t].failure);
    heroSlot.innerHTML = `<p class="empty-state">${
      anyReachable
        ? 'No signal currently clears the worker\'s scoring threshold.'
        : esc(failureText('upstream_unavailable', { what: 'Signal scoring' }))
    }</p>`;
    return;
  }
  const caveat = fittedCaveat(best);
  const el = document.createElement('section');
  el.className = 'hero-signal';
  el.innerHTML = `
    <div class="hero-top">
      <div>
        <h2><a href="${itemHref(best.item)}">${esc(itemLabel(best.item))}</a></h2>
        <span class="hero-item-id">${esc(best.item)}</span>
      </div>
      <div class="tabs">
        <span class="type-badge">${esc(best.type)}</span>
        ${best.direction ? `<span class="type-badge ${esc(best.direction)}">${esc(best.direction)}</span>` : ''}
      </div>
    </div>
    <p class="thesis">${esc(best.thesis || best.why)}</p>
    <div class="hero-figures">
      <div class="stat"><span class="label">Score</span><span class="value lg accent">${best.score.toFixed(2)}</span></div>
      <div class="stat"><span class="label">Net / order</span><span class="value lg ${signClass(best.netPerUnit)}">${best.capacity ? formatCompact(best.capacity.netPerOrder) : formatCoins(best.netPerUnit)}</span><p class="note">${formatCoins(best.netPerUnit)} a unit</p></div>
      <div class="stat"><span class="label">Margin</span><span class="value lg ${signClass(best.marginPct)}">${formatPctSigned(best.marginPct)}</span></div>
      <div class="stat"><span class="label">Entry</span><span class="value buy-c">${formatCoins(best.entry.price)}</span><p class="note">${esc(methodLabel(best.entry.method))} · ${esc(formatFillMinutes(best.entry.estFillMinutes))}</p></div>
      <div class="stat"><span class="label">Exit</span><span class="value sell-c">${formatCoins(best.exit.price)}</span><p class="note">${esc(methodLabel(best.exit.method))} · ${esc(formatFillMinutes(best.exit.estFillMinutes))}</p></div>
      <div class="stat"><span class="label">${best.holdDays ? 'Hold' : 'Suggested qty'}</span><span class="value">${best.holdDays ? esc(formatHoldDays(best.holdDays)) : formatInt(best.suggestedQty)}</span></div>
    </div>
    ${caveat ? `<p class="caveat">${esc(caveat)}</p>` : ''}
  `;
  heroSlot.appendChild(el);
  if (bestMeta && strip) strip.update({ taxRate: bestMeta.taxRate, generatedAt: bestMeta.generatedAt });
}

/* --- Table ------------------------------------------------------------------------------------ */

const COLUMNS = [
  { key: null, label: '', num: false },
  { key: 'item', label: 'Item', num: false },
  { key: 'entry', label: 'Entry', num: true, get: (s) => (s.entry ? s.entry.price : null) },
  { key: 'exit', label: 'Exit', num: true, get: (s) => (s.exit ? s.exit.price : null) },
  { key: 'netPerUnit', label: 'Net / unit', num: true },
  { key: 'marginPct', label: 'Margin', num: true },
  { key: 'netPerOrder', label: 'Net / order', num: true, get: (s) => s.capacity?.netPerOrder ?? null, title: 'Net coins one order earns at the suggested size – what the 71,680-unit order cap leaves of the margin.' },
  { key: 'netPerActiveHour', label: 'Per hour played', num: true, get: (s) => s.capacity?.netPerActiveHour ?? null, title: 'Net coins per hour of hands-on time: GUI actions, relists, inventory loads.' },
  { key: 'suggestedQty', label: 'Qty', num: true },
  { key: 'score', label: 'Score', num: true },
];

function sortValue(signal, key) {
  const col = COLUMNS.find((c) => c.key === key);
  if (col && col.get) return col.get(signal);
  if (key === 'item') return signal.item;
  return signal[key];
}

function renderTable() {
  const entry = byType[activeType];
  tableSlot.innerHTML = '';
  if (!entry) {
    tableSlot.innerHTML = '<p class="loading-state">Loading signals…</p>';
    return;
  }
  if (entry.failure) {
    renderErrorState(tableSlot, entry.failure, { what: `${activeType[0].toUpperCase()}${activeType.slice(1)} signals` });
    return;
  }
  if (entry.signals.length === 0) {
    tableSlot.innerHTML = `<p class="empty-state">No ${esc(activeType)} signal currently clears the worker's scoring threshold.</p>`;
    return;
  }

  const rows = entry.signals.slice().sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av).localeCompare(String(bv)) * sortDir;
    }
    return ((av ?? -Infinity) - (bv ?? -Infinity)) * sortDir;
  });

  const head = COLUMNS.map((c) => {
    if (!c.key) return '<th style="width:1.6rem"></th>';
    const sorted = c.key === sortKey;
    return `<th class="${c.num ? 'num ' : ''}sortable" data-key="${c.key}"${c.title ? ` title="${esc(c.title)}"` : ''}${
      sorted ? ` aria-sort="${sortDir === -1 ? 'descending' : 'ascending'}"` : ''
    }>${c.label}<span class="arrow">${sorted && sortDir === 1 ? '↑' : '↓'}</span></th>`;
  }).join('');

  const body = rows.map((s, i) => `
    <tr class="signal-row" data-i="${i}">
      <td><button class="expand-btn" type="button" aria-expanded="false" aria-controls="d${i}" aria-label="Show all fields">&#9656;</button></td>
      <td class="key"><a href="${itemHref(s.item)}">${esc(itemLabel(s.item))}</a>
        <span class="why-line">${esc(s.why)}</span></td>
      <td class="num buy-c">${legCell(s.entry)}</td>
      <td class="num sell-c">${legCell(s.exit)}</td>
      <td class="num ${signClass(s.netPerUnit)}">${formatCoins(s.netPerUnit)}</td>
      <td class="num ${signClass(s.marginPct)}">${formatPctSigned(s.marginPct)}</td>
      <td class="num strong">${s.capacity ? formatCompact(s.capacity.netPerOrder) : '–'}</td>
      <td class="num">${s.capacity?.netPerActiveHour ? formatCompact(s.capacity.netPerActiveHour) : '–'}</td>
      <td class="num">${formatCompact(s.suggestedQty)}</td>
      <td class="num">${s.score.toFixed(2)}</td>
    </tr>
    <tr class="detail-row" id="d${i}" hidden><td colspan="${COLUMNS.length}">${detailPanel(s, entry)}</td></tr>
  `).join('');

  tableSlot.innerHTML = `
    <div class="table-wrap"><div class="table-scroll">
      <table class="ledger"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    </div></div>
    <p class="dimmer" style="font-size:0.75rem;margin-top:0.6rem">
      Score ranks within this type only – a craft's 0.70 and a position's 0.65 are not comparable.
      ${getSettings().capital > 0 ? 'Sizes and scores are fitted to your capital.' : 'Set your capital above to size every trade to your bankroll.'}
    </p>
  `;

  tableSlot.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (key === sortKey) sortDir = -sortDir;
      else { sortKey = key; sortDir = key === 'item' ? 1 : -1; }
      renderTable();
    });
  });

  tableSlot.querySelectorAll('.expand-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      document.getElementById(btn.getAttribute('aria-controls')).hidden = open;
    });
  });
}

/* --- Load --------------------------------------------------------------------------------------
   Each type is fetched independently and fails independently: `spread` returning
   UPSTREAM_UNAVAILABLE must not blank out `position`, which is exactly what the old page did. */

async function loadType(type) {
  try {
    const { capital } = getSettings();
    const { status, body } = await callWorker(`/signals?type=${type}&limit=50${capital > 0 ? `&capital=${capital}` : ''}`);
    if (status === 200) {
      byType[type] = { signals: body.signals || [], taxRate: body.taxRate, generatedAt: body.generatedAt };
    } else {
      byType[type] = { failure: classifyFailure(null, body) || 'unknown' };
    }
  } catch (err) {
    byType[type] = { failure: err instanceof WorkerUnreachableError ? 'unreachable' : 'unknown' };
  }
}

tabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    activeType = btn.dataset.type;
    sortKey = 'score';
    sortDir = -1;
    tabs.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    renderTable();
  });
});

strip = mountStatusStrip(document.getElementById('status-strip'));
mountSettingsBar(document.getElementById('settings-bar'));

async function loadAll() {
  await Promise.all(TYPES.map(loadType));
  renderHero();
  renderTable();
}

let lastCapital = getSettings().capital;
onSettingsChange((s) => {
  if (s.capital === lastCapital) return;
  lastCapital = s.capital;
  for (const t of TYPES) delete byType[t];
  renderTable();
  loadAll();
});

loadAll();
