// Item detail – the site's signature surface (docs/BRAND.md): a glowing hairline chart of
// GET /history and GET /predict, plus every field the snapshot, the prediction, the signal list
// and the backtest have to say about one product.
//
// No chart maths beyond drawing and windowing (CLAUDE.md hard rule 2). The window itself is
// docs/CONTRACTS.md's chart window contract, taken from the worker's own `futureMs` rather than
// guessed from the data extent: futureMs is 30% of the range span, so the "now" line lands at
// exactly 70% of the plot width for every range.
import { callWorker, WorkerUnreachableError } from './api.js';
import { renderErrorState, classifyFailure, failureText } from './errors.js';
import { loadSnapshot } from './catalog.js';
import { mountStatusStrip, itemHref } from './shell.js';
import {
  formatCoins, formatCoinsPrecise, formatCompact, formatInt, formatPct, formatPctSigned,
  formatLocalTime, formatLocalShort, formatDuration, formatFillMinutes, formatHoldDays,
  methodLabel, itemLabel, esc, signClass,
} from './format.js';

const params = new URLSearchParams(window.location.search);
const itemId = (params.get('id') || params.get('item') || '').toUpperCase();

const titleEl = document.getElementById('item-title');
const idEl = document.getElementById('item-id');
const quoteStrip = document.getElementById('quote-strip');
const chartCard = document.getElementById('chart-card');
const modelBody = document.getElementById('model-body');
const eventsBody = document.getElementById('events-body');
const signalsSlot = document.getElementById('item-signals');
const backtestSlot = document.getElementById('backtest-slot');
const rangeTabs = document.querySelectorAll('#range-tabs .tab');

/** Fallback window widths when /predict is unavailable and cannot supply futureMs. */
const RANGE_MS = {
  '1h': 3600e3, '1d': 86400e3, '1w': 7 * 86400e3, '1M': 30 * 86400e3,
  '3M': 90 * 86400e3, '6M': 180 * 86400e3,
};

// Mirrors worker/src/ingest/bars.js's RANGE_BAR_MS / RANGE_POINTS (docs/CONTRACTS.md's /history
// point-count table). No shared import across the worker/web boundary on a static, build-step-free
// site, so this is a deliberate duplicate – keep it in lockstep with the worker if that table moves.
const RANGE_BAR_MS = { '1h': 60e3, '1d': 300e3, '1w': 3600e3, '1M': 3600e3, '3M': 28_800e3, '6M': 86_400e3 };
const RANGE_POINTS = { '1h': 60, '1d': 288, '1w': 168, '1M': 372, '3M': 279, '6M': 186 };

/** The actual replay span for a range's stored bars – not always equal to RANGE_MS's calendar
 * shorthand (1M's 372 hourly bars is ~15.5 days, not 30), so the backtest label must derive it
 * from the real bar width and count rather than assume the range name means what it sounds like. */
function rangeWindowMs(r) {
  return RANGE_BAR_MS[r] * RANGE_POINTS[r];
}

// Mirrors api/backtest.js's and api/predict.js's FUTURE_FRACTION – docs/CONTRACTS.md's "the chart
// window puts futureMs at 30% of the range span" is one rule, so this is the same constant those
// derive from, not an independent guess.
const FUTURE_FRACTION = 0.3;

/** How far past `from` a backtest of range `r` actually replays – the worker derives futureMs the
 * same way, and it is what the result footer reports, so the button must name this and not the
 * whole window or the two contradict each other on screen. */
function backtestHorizonMs(r) {
  return rangeWindowMs(r) * FUTURE_FRACTION;
}

// 1w, not 1d: the 1d tier is bars_5m, which ingest/cron.js writes only for the 100 highest-volume
// products (a D1 write-cap decision, not a bug), so it is empty for most of the catalogue. 1w reads
// bars_1h, which covers every product – the default range has to be one that actually has data.
let range = '1w';
let chart = null;
let lastPayload = null; // { history, predict } – kept so a theme flip can repaint without refetching
let backtestHasRun = false; // flips the button's copy from "Run a … backtest" to "Run again"
let nowTicker = null; // interval id for the chart's live "now" marker, cleared on rebuild/pagehide

titleEl.textContent = itemId ? itemLabel(itemId) : 'No item selected';
idEl.textContent = itemId;
document.title = itemId ? `${itemLabel(itemId)} – Lucrum` : 'Item – Lucrum';

const strip = mountStatusStrip(document.getElementById('status-strip'));

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function withAlpha(hex, alpha) {
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
  return `${hex}${a}`;
}

/* --- Live quote --------------------------------------------------------------------------------
   The snapshot fields were never shown before; a chart with no current quote beside it is half a
   page. Everything here is verbatim from GET /snapshot. */

function renderQuote(snap) {
  const p = (snap.products || {})[itemId];
  if (!p) {
    quoteStrip.innerHTML = `<p class="dim" style="grid-column:1/-1;margin:0">${esc(failureText('item_not_found', { item: itemId }))}</p>`;
    return;
  }
  const cell = (label, value, cls = '', note = '') => `
    <div class="stat"><span class="label">${label}</span>
      <span class="value ${cls}">${value}</span>
      ${note ? `<p class="note">${note}</p>` : ''}
    </div>`;
  quoteStrip.innerHTML = [
    cell('Instant buy', formatCoins(p.instantBuy), 'buy-c', `best order ${formatCoins(p.bestBuyOrder)}`),
    cell('Instant sell', formatCoins(p.instantSell), 'sell-c', `best offer ${formatCoins(p.bestSellOffer)}`),
    cell('Spread', formatCoins(p.spread), signClass(p.spread), formatPctSigned(p.spreadPct, 2)),
    cell('Buy depth', formatCompact(p.buyVolume), '', `${formatInt(p.buyOrders)} orders`),
    cell('Sell depth', formatCompact(p.sellVolume), '', `${formatInt(p.sellOrders)} orders`),
    cell('Traded / week', formatCompact(p.sellMovingWeek), '', `${formatCompact(p.buyMovingWeek)} bought`),
  ].join('');
  strip.update({ taxRate: snap.taxRate, mayor: snap.mayor });
}

/* --- Chart -------------------------------------------------------------------------------------
   Two plugins: `glow` gives every stroked series a halo in its own hue (the signature element,
   scaled by the --glow token so the light theme switches it off), `chrome` draws the now-line and
   the event marks. No annotation plugin, so the visual weight stays exactly what BRAND.md says. */

function glowPlugin() {
  const strength = Number(cssVar('--glow')) || 0; // read once per build – see chromePlugin
  return {
    id: 'lucrumGlow',
    beforeDatasetDraw(c, args) {
      const ds = c.data.datasets[args.index];
      if (!ds.glow) return;
      if (!strength) return;
      c.ctx.shadowColor = ds.borderColor;
      c.ctx.shadowBlur = ds.glow * strength;
    },
    afterDatasetDraw(c) {
      c.ctx.shadowBlur = 0;
      c.ctx.shadowColor = 'transparent';
    },
  };
}

// nowRef is a mutable { value } box, not a plain timestamp: CLAUDE.md rule 12 requires anything
// that counts up or down to re-render on a tick, and this plugin instance is baked into the
// chart at construction time, so the only way for the marker to keep moving after that is for the
// draw call to read a value the ticker below can update in place.
function chromePlugin(nowRef, events) {
  // Theme colours read once per chart build, not on every frame: getComputedStyle is the most
  // expensive call in this plugin and the marker redraws every second. A theme flip rebuilds the
  // chart (buildChart), so the cache cannot go stale.
  const colours = { accent: cssVar('--accent'), lineStrong: cssVar('--line-strong'), text3: cssVar('--text-3') };
  return {
    id: 'lucrumChrome',
    afterDatasetsDraw(c) {
      const { ctx, chartArea, scales } = c;
      const x = scales.x;
      if (!x || !chartArea) return;
      ctx.save();
      ctx.shadowBlur = 0;

      const nowPx = x.getPixelForValue(nowRef.value);
      if (nowPx >= chartArea.left && nowPx <= chartArea.right) {
        ctx.strokeStyle = colours.accent;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(nowPx, chartArea.top);
        ctx.lineTo(nowPx, chartArea.bottom);
        ctx.stroke();
        ctx.fillStyle = colours.accent;
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.fillText('now', nowPx + 4, chartArea.bottom - 4);
      }

      ctx.setLineDash([3, 3]);
      ctx.font = '10px "JetBrains Mono", monospace';
      for (const ev of events) {
        const px = x.getPixelForValue(ev.t);
        if (px < chartArea.left || px > chartArea.right) continue;
        ctx.strokeStyle = colours.lineStrong;
        ctx.beginPath();
        ctx.moveTo(px, chartArea.top);
        ctx.lineTo(px, chartArea.bottom);
        ctx.stroke();
        ctx.fillStyle = colours.text3;
        ctx.fillText(ev.fitted === false ? `${ev.label} (unfitted)` : ev.label, px + 4, chartArea.top + 11);
      }
      ctx.setLineDash([]);
      ctx.restore();
    },
  };
}

function tickFormat(ts, spanMs) {
  const d = new Date(ts);
  if (spanMs <= 26 * 3600000) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (spanMs <= 40 * 86400000) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

function buildChart({ history, predict }) {
  const bars = history.bars || [];
  const now = predict ? predict.now : Date.now();
  const futureMs = predict ? predict.futureMs : RANGE_MS[range] * 0.3;
  const spanMs = futureMs / 0.3;
  const windowStart = now - spanMs * 0.7;
  const windowEnd = now + futureMs;

  const buy = cssVar('--buy');
  const sell = cssVar('--sell');
  const line = cssVar('--line');
  const lineStrong = cssVar('--line-strong');
  const text = cssVar('--text');
  const textDim = cssVar('--text-3');
  const surface = cssVar('--surface');

  const datasets = [
    {
      label: 'Buy', data: bars.map((b) => ({ x: b.t, y: b.bc })),
      borderColor: buy, borderWidth: 1.5, pointRadius: 0, tension: 0.1, glow: 10,
    },
    {
      label: 'Sell', data: bars.map((b) => ({ x: b.t, y: b.sc })),
      borderColor: sell, borderWidth: 1.5, pointRadius: 0, tension: 0.1, glow: 10,
    },
  ];

  if (predict) {
    const band = { pointRadius: 0, borderWidth: 0, borderColor: 'transparent', tension: 0.15, spanGaps: true };
    const at = (p) => now + p.t;
    datasets.push(
      { label: 'Buy band hi', data: predict.buy.map((p) => ({ x: at(p), y: p.hi })), ...band },
      { label: 'Buy band lo', data: predict.buy.map((p) => ({ x: at(p), y: p.lo })), ...band, fill: '-1', backgroundColor: withAlpha(buy, 0.1) },
      { label: 'Sell band hi', data: predict.sell.map((p) => ({ x: at(p), y: p.hi })), ...band },
      { label: 'Sell band lo', data: predict.sell.map((p) => ({ x: at(p), y: p.lo })), ...band, fill: '-1', backgroundColor: withAlpha(sell, 0.1) },
      {
        label: 'Buy forecast', data: predict.buy.map((p) => ({ x: at(p), y: p.p })),
        borderColor: buy, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, tension: 0.15, glow: 12,
      },
      {
        label: 'Sell forecast', data: predict.sell.map((p) => ({ x: at(p), y: p.p })),
        borderColor: sell, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, tension: 0.15, glow: 12,
      },
    );
  }

  const events = predict ? (predict.events || []) : [];

  // buildTime anchors the ticker below: it advances `now` by wall-clock time elapsed since this
  // chart was built, rather than re-reading Date.now() outright, so a client/worker clock skew
  // shows up as a constant (harmless) offset instead of a jump each time the marker ticks.
  const buildTime = Date.now();
  const nowRef = { value: now };

  if (chart) chart.destroy();
  if (nowTicker) { clearInterval(nowTicker); nowTicker = null; }
  const canvas = document.getElementById('chart');
  chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: {
      animation: false,
      // Every dataset is already {x, y} points in ascending x (built above), so Chart.js can skip
      // its parse pass and its sort/uniqueness checks – the Phase 9 performance pass.
      parsing: false,
      normalized: true,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false, axis: 'x' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: surface,
          titleColor: text,
          bodyColor: textDim,
          borderColor: lineStrong,
          borderWidth: 1,
          titleFont: { family: 'Inter, system-ui, sans-serif', weight: '600' },
          bodyFont: { family: '"JetBrains Mono", monospace' },
          padding: 10,
          callbacks: {
            title: (items) => (items[0] ? formatLocalTime(items[0].parsed.x) : ''),
            label: (item) => `${item.dataset.label}: ${formatCoins(item.parsed.y)}`,
          },
          filter: (item) => !item.dataset.label.includes('band'),
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: windowStart,
          max: windowEnd,
          grid: { color: line, drawTicks: false },
          border: { color: line },
          ticks: {
            color: textDim, maxTicksLimit: 8, autoSkip: true,
            font: { family: '"JetBrains Mono", monospace', size: 10 },
            callback: (v) => tickFormat(v, spanMs),
          },
        },
        y: {
          grid: { color: line, drawTicks: false },
          border: { color: line },
          ticks: {
            color: textDim,
            font: { family: '"JetBrains Mono", monospace', size: 10 },
            callback: (v) => formatCompact(v),
          },
        },
      },
    },
    plugins: [glowPlugin(), chromePlugin(nowRef, events)],
  });

  // Retick the "now" marker every second so it keeps advancing through the fixed window instead
  // of freezing at page-load time (CLAUDE.md rule 12). This is purely local redrawing – no worker
  // call of any kind – because 2026-09-06 already burned the whole day's D1 free-tier row-read
  // budget once; an auto-refresh loop on an open item page would reintroduce exactly that outage.
  // `chart.draw()` repaints with the existing layout: the axes are fixed to the window, so the
  // full `update()` this used to call – re-parsing every dataset and re-laying-out both scales
  // once a second – bought nothing. A hidden tab skips the repaint entirely; the marker is
  // recomputed from the clock on the next visible tick, so it never shows a stale position.
  nowTicker = setInterval(() => {
    if (document.hidden) return;
    nowRef.value = now + (Date.now() - buildTime);
    chart.draw();
  }, 1000);
}

/* --- Model + events panels ---------------------------------------------------------------------- */

function renderModel(predict, historyMeta) {
  if (!predict) return;
  const lastBuy = predict.buy[0];
  const endBuy = predict.buy[predict.buy.length - 1];
  const lastSell = predict.sell[0];
  const endSell = predict.sell[predict.sell.length - 1];
  const move = (a, b) => (a && b && a.p ? (b.p - a.p) / a.p : null);

  const basisText = (b) => {
    if (!b) return '–';
    if (b.shape === 'flat') return 'flat – nothing beat a flat line on this item\'s past';
    const what = b.shape === 'reversion' ? 'reversion to the recent median' : 'fitted cycles and drift';
    return `${what} at ${formatPct(b.weight, 0)} – ${formatPct(b.improvement, 0)} less error than flat over ${b.origins} past windows`;
  };
  const rows = [
    ['Confidence', formatPct(predict.confidence), predict.confidence >= 0.5 ? '' : 'dim'],
    ['Model', esc(predict.modelVersion || '–'), ''],
    ['Buy curve rests on', esc(basisText(predict.basis && predict.basis.buy)), predict.basis && predict.basis.buy && predict.basis.buy.shape === 'flat' ? 'dim' : ''],
    ['Sell curve rests on', esc(basisText(predict.basis && predict.basis.sell)), predict.basis && predict.basis.sell && predict.basis.sell.shape === 'flat' ? 'dim' : ''],
    ['Horizon', formatDuration(predict.futureMs), ''],
    ['Step', formatDuration(predict.stepMs), ''],
    ['Buy at horizon', `${formatCoins(endBuy && endBuy.p)} <span class="${signClass(move(lastBuy, endBuy))}">${formatPctSigned(move(lastBuy, endBuy))}</span>`, ''],
    ['Sell at horizon', `${formatCoins(endSell && endSell.p)} <span class="${signClass(move(lastSell, endSell))}">${formatPctSigned(move(lastSell, endSell))}</span>`, ''],
    ['Bar width', historyMeta ? formatDuration(historyMeta.barMs) : '–', historyMeta ? '' : 'dim'],
    ['Bars returned', historyMeta ? formatInt((historyMeta.bars || []).length) : 'none stored', historyMeta ? '' : 'dim'],
  ];

  modelBody.innerHTML = `
    <div class="detail-grid">
      ${rows.map(([l, v]) => `<div><span class="label">${l}</span><span class="value">${v}</span></div>`).join('')}
    </div>
    <p class="dim" style="font-size:0.8rem;margin:0.9rem 0 0">
      Every curve starts at the last price. It bends only where a shape beat a flat line on this
      item's own history – most bazaar prices are sticky enough that "it stays here" is the honest
      forecast. A calendar event widens the band on the side it is expected to push, without moving
      the line: measured event effects have not yet beaten noise. Confidence falls when history is
      thin relative to the horizon, when the price jumps a lot, or when an unfitted event effect is
      large.
    </p>`;
}

function renderEvents(predict) {
  const events = predict ? (predict.events || []) : [];
  if (!events.length) {
    eventsBody.innerHTML = `<p class="dim" style="margin:0">No modelled event moves this product over the next ${
      predict ? esc(formatDuration(predict.futureMs)) : 'horizon'
    }. The full schedule is on the <a href="../calendar/">calendar</a>.</p>`;
    return;
  }
  eventsBody.innerHTML = `
    <ul class="event-list">
      ${events.map((e) => `
        <li class="event-row" style="padding-left:0;padding-right:0">
          <div>
            <span class="event-name">${esc(e.label)}</span>
            <span class="event-source">${esc(e.id)}${e.fitted === false ? ' · unfitted placeholder' : ' · fitted from history'}</span>
          </div>
          <div class="event-when">
            <span class="event-countdown ${signClass(e.effect)}">${formatPctSigned(e.effect, 1)}</span>
            <span class="event-time">${esc(formatLocalShort(e.t))}</span>
          </div>
        </li>`).join('')}
    </ul>
    ${events.some((e) => e.fitted === false) ? `<p class="caveat">${
      esc(events.filter((e) => e.fitted === false).map((e) => e.label).join(', '))
    }: modelled with a conservative placeholder magnitude, not one measured from stored history.</p>` : ''}`;
}

/* --- Signals on this item ------------------------------------------------------------------------ */

async function renderItemSignals() {
  const types = ['position', 'spread', 'craft', 'event'];
  const results = await Promise.all(types.map(async (t) => {
    try {
      const { status, body } = await callWorker(`/signals?type=${t}&limit=50`);
      return status === 200 ? (body.signals || []).filter((s) => s.item === itemId) : [];
    } catch (err) {
      return [];
    }
  }));
  const found = results.flat();
  if (!found.length) {
    signalsSlot.innerHTML = `<p class="empty-state">No current signal on ${esc(itemLabel(itemId))}. <a href="../signals/">Browse everything the model does like &rarr;</a></p>`;
    return;
  }
  signalsSlot.innerHTML = `
    <div class="table-wrap"><div class="table-scroll"><table class="ledger">
      <thead><tr>
        <th>Type</th><th class="num">Entry</th><th class="num">Exit</th>
        <th class="num">Net / unit</th><th class="num">Margin</th><th class="num">Qty</th><th class="num">Score</th>
      </tr></thead>
      <tbody>${found.map((s) => `
        <tr>
          <td class="key">${esc(s.type)}${s.direction ? ` <span class="type-badge ${esc(s.direction)}">${esc(s.direction)}</span>` : ''}
            <span class="why-line">${esc(s.thesis || s.why)}</span>
            ${s.holdDays ? `<span class="why-line">Hold ${esc(formatHoldDays(s.holdDays))}</span>` : ''}</td>
          <td class="num buy-c">${formatCoins(s.entry.price)}<span class="why-line">${esc(methodLabel(s.entry.method))} · ${esc(formatFillMinutes(s.entry.estFillMinutes))}</span></td>
          <td class="num sell-c">${formatCoins(s.exit.price)}<span class="why-line">${esc(methodLabel(s.exit.method))} · ${esc(formatFillMinutes(s.exit.estFillMinutes))}</span></td>
          <td class="num ${signClass(s.netPerUnit)}">${formatCoinsPrecise(s.netPerUnit)}</td>
          <td class="num ${signClass(s.marginPct)}">${formatPctSigned(s.marginPct)}</td>
          <td class="num">${formatCompact(s.suggestedQty)}</td>
          <td class="num">${s.score.toFixed(2)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div></div>`;
}

/* --- Backtest ------------------------------------------------------------------------------------
   On demand: docs/CONTRACTS.md's /backtest replays the model with a clock that hides everything at
   or after `from`, so it is the most expensive call the worker serves. A negative skill is a
   failing result and is stated as one. */

// The button's copy names the horizon it will actually replay forward over, which is what the
// result footer then reports back as body.futureMs – naming the whole range window instead would
// have the button and its own result contradicting each other. A fixed "24 hours" was wrong for
// every range but 1d, since the horizon is a property of the selected range, not a constant.
function backtestButtonLabel(again) {
  const horizon = formatDuration(backtestHorizonMs(range));
  return again ? `Run again – ${horizon}` : `Run a ${horizon} backtest`;
}

/** Keeps the visible button's copy in step with the range tabs even before a run – skipped while
 * a request is in flight (`disabled`) so it does not clobber the "Running…" text. */
function refreshBacktestButtonLabel() {
  const btn = document.getElementById('backtest-btn');
  if (btn && !btn.disabled) btn.textContent = backtestButtonLabel(backtestHasRun);
}

function renderBacktest(body) {
  backtestHasRun = true;
  const m = body.metrics || {};
  const skillNote = m.skill === null || m.skill === undefined
    ? 'Skill is undefined here – the flat baseline made no error to improve on.'
    : m.skill > 0
      ? 'Positive skill: the model beat holding the last price flat over this window.'
      : 'Negative skill: over this window the model was worse than assuming the price does not move.';
  const cell = (label, value, cls = '', note = '') => `
    <div class="stat"><span class="label">${label}</span><span class="value ${cls}">${value}</span>
    ${note ? `<p class="note">${note}</p>` : ''}</div>`;

  backtestSlot.innerHTML = `
    <div class="card">
      <div class="grid grid-4">
        ${cell('Skill', m.skill === null || m.skill === undefined ? '–' : formatPctSigned(m.skill), signClass(m.skill), 'vs flat baseline')}
        ${cell('MAE', formatCoinsPrecise(m.mae), '', `baseline ${formatCoinsPrecise(m.maeNaive)}`)}
        ${cell('Directional', m.directionalAccuracy === null || m.directionalAccuracy === undefined ? '–' : formatPct(m.directionalAccuracy), '', 'right direction')}
        ${cell('Net / unit', formatCoinsPrecise(m.netPnlPerUnit), signClass(m.netPnlPerUnit), 'simulated fills')}
        ${cell('Trades', formatInt(m.trades), '', m.winRate === null || m.winRate === undefined ? 'no win rate' : `${formatPct(m.winRate)} won`)}
        ${cell('Scored points', formatInt(body.points), '', `qty ${formatCompact(body.quantity)}`)}
      </div>
      <p class="dim" style="font-size:0.82rem;margin:1rem 0 0">${esc(skillNote)}</p>
      <p class="dimmer" style="font-size:0.78rem;margin:0.4rem 0 0">
        Replayed from ${esc(formatLocalTime(body.from))} over ${esc(formatDuration(body.futureMs))},
        model ${esc(body.modelVersion || '–')}. Net per unit assumes both legs reach the top of
        book, so read it alongside skill, not instead of it.
      </p>
      <p style="margin:0.9rem 0 0"><button class="btn btn-sm" id="backtest-btn" type="button">${esc(backtestButtonLabel(true))}</button></p>
    </div>`;
  wireBacktest();
}

function wireBacktest() {
  const btn = document.getElementById('backtest-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Running…';
    // Anchored to the horizon, not a fixed 24 hours, and deliberately as recent as the data
    // allows. Two opposing constraints meet here: the worker replays forward from `from` by
    // futureMs and can only score that against bars that already exist, so `from` has to sit at
    // least a horizon in the past or the replay runs off the end of history and is silently scored
    // on only the part that has happened – but it also needs quant/predict.js's MIN_BARS of
    // history *before* `from`, and only ~7 days of hourly bars are stored so far. Anchoring a
    // whole window back satisfies the first and fails the second on 1w. One horizon back, plus two
    // closed bars of margin so the last scored bar is definitely written, satisfies both and
    // scores the model on its most recent completed window rather than a stale one.
    const from = Date.now() - backtestHorizonMs(range) - 2 * RANGE_BAR_MS[range];
    // range, not a hardcoded '1d': '1d' resolves to the bars_5m tier, which ingest/cron.js only
    // writes for the ~100 highest-volume products (a deliberate D1 write-cap decision), so a
    // literal '1d' here made the backtest fail for roughly 1,900 of ~2,000 products. Using the
    // chart's own selected range makes the backtest describe the same window the user is already
    // looking at, and since the chart defaults to '1w' (bars_1h, populated for every product) the
    // default path works everywhere.
    try {
      const { status, body } = await callWorker(`/backtest?item=${encodeURIComponent(itemId)}&from=${from}&range=${range}`);
      if (status !== 200) {
        renderErrorState(backtestSlot, classifyFailure(null, body) || 'unknown', { item: itemId, range });
        return;
      }
      renderBacktest(body);
    } catch (err) {
      renderErrorState(backtestSlot, 'unreachable');
    }
  });
}

/* --- Load ---------------------------------------------------------------------------------------- */

function setRangePressed() {
  rangeTabs.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
}

function chartShell() {
  chartCard.innerHTML = `
    <div class="chart-wrap"><canvas id="chart"></canvas></div>
    <div class="chart-legend">
      <span class="buy-c"><span class="swatch" style="background:var(--buy)"></span>Buy side</span>
      <span class="sell-c"><span class="swatch" style="background:var(--sell)"></span>Sell side</span>
      <span><span class="swatch dashed"></span>Forecast</span>
      <span><span class="swatch" style="background:var(--line-strong)"></span>Uncertainty band</span>
    </div>`;
}

async function loadChart() {
  if (!itemId) {
    renderErrorState(chartCard, 'item_not_found', { item: '(none given)' });
    return;
  }
  let historyRes;
  let predictRes;
  try {
    [historyRes, predictRes] = await Promise.all([
      callWorker(`/history?item=${encodeURIComponent(itemId)}&range=${range}`),
      callWorker(`/predict?item=${encodeURIComponent(itemId)}&range=${range}`),
    ]);
  } catch (err) {
    if (err instanceof WorkerUnreachableError) {
      renderErrorState(chartCard, 'unreachable');
      modelBody.innerHTML = '';
      return;
    }
    throw err;
  }

  // A missing prediction is not a missing page: the history still draws, and the model panel says
  // in plain words why there is no curve. CLAUDE.md rule 6.
  const predict = predictRes.status === 200 ? predictRes.body : null;
  const history = historyRes.status === 200 ? historyRes.body : null;
  const historyKind = history ? null : (classifyFailure(null, historyRes.body) || 'unknown');

  // Nor is missing history: /history now returns whatever part of the window is actually stored
  // (docs/CONTRACTS.md's coverage object) rather than refusing the whole request the moment the
  // window reaches back further than storage does. INSUFFICIENT_HISTORY only survives for the
  // genuinely empty case – zero stored bars anywhere in the window – where nothing but the
  // forecast can be drawn. A trimmed-but-nonempty series still charts, against the real time
  // axis, with the blank stretch on the left named rather than hidden or stretched to fill it.
  if (!history && !predict) {
    renderErrorState(chartCard, historyKind, { item: itemId, range });
    modelBody.innerHTML = `<p class="dim" style="margin:0">${esc(failureText(historyKind, { item: itemId, range }))}</p>`;
    eventsBody.innerHTML = '';
    return;
  }

  chartShell();
  if (!history) {
    const caveat = document.createElement('p');
    caveat.className = 'caveat';
    caveat.textContent = `${failureText(historyKind, { item: itemId, range })} Only the forecast is drawn – the line left of now is missing, not flat.`;
    chartCard.insertBefore(caveat, chartCard.firstChild);
  } else if (history.coverage && history.coverage.truncated) {
    // Real bars, just fewer than the range asks for – state where they begin instead of implying
    // the whole window is covered. CLAUDE.md rule 12: the time shown is the reader's local clock.
    const caveat = document.createElement('p');
    caveat.className = 'caveat';
    caveat.textContent = `Stored history for ${itemLabel(itemId)} begins ${formatLocalTime(history.coverage.from)} – the range before that is blank, not flat.`;
    chartCard.insertBefore(caveat, chartCard.firstChild);
  }
  lastPayload = { history: history || { bars: [] }, predict };
  buildChart(lastPayload);

  if (predict) {
    renderModel(predict, history);
    renderEvents(predict);
  } else {
    const kind = classifyFailure(null, predictRes.body) || 'unknown';
    modelBody.innerHTML = `<p class="dim" style="margin:0">${esc(failureText(kind, { item: itemId, range }))}</p>`;
    eventsBody.innerHTML = '<p class="dim" style="margin:0">Event marks come with the prediction, which is unavailable for this range.</p>';
  }
}

rangeTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    range = btn.dataset.range;
    setRangePressed();
    refreshBacktestButtonLabel();
    loadChart();
  });
});

// A canvas reads CSS variables at draw time, so it cannot re-theme the way the DOM does – repaint
// from the payload already in hand rather than refetching.
window.LucrumTheme.onChange(() => { if (lastPayload) buildChart(lastPayload); });

// Matches the pattern in shell.js's mountStatusStrip and calendar.js: reads whichever ticker is
// current at unload time rather than a snapshot, so a range change earlier in the session (which
// swaps nowTicker for a fresh one) cannot leave the old interval running past pagehide.
window.addEventListener('pagehide', () => { if (nowTicker) clearInterval(nowTicker); });

setRangePressed();
wireBacktest();
refreshBacktestButtonLabel(); // the static HTML label names 1d/24h; correct it to the default range
loadChart();
renderItemSignals();
loadSnapshot().then(renderQuote).catch(() => {
  quoteStrip.innerHTML = `<p class="dim" style="grid-column:1/-1;margin:0">${esc(failureText('unreachable'))}</p>`;
});
