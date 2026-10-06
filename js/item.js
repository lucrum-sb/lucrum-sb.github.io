// Item detail – the site's signature surface (docs/BRAND.md): a glowing hairline chart of
// GET /history and GET /predict, plus every field the snapshot, the prediction, the signal list
// and the backtest have to say about one product.
//
// No chart maths beyond drawing and windowing (CLAUDE.md hard rule 2). History range and forecast
// length are separate choices, the window is zoomable and pannable, and a click on the past draws a
// backtest from there – see docs/CONTRACTS.md's chart window contract for what differs from the mod.
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
const forecastTabs = document.querySelectorAll('#forecast-tabs .tab');
const lineTabs = document.querySelectorAll('#line-tabs .tab');
const modelTabs = document.querySelectorAll('#model-tabs .tab');
const compareSelect = document.getElementById('compare-model');

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
// How far ahead the forecast looks, as its own choice: it names one of the worker's model tiers
// (1w = 2 days, 1M = 5 days, 3M = 4 weeks). Changing the history shown never changes the forecast,
// and a longer forecast is a different, separately validated model, not the same line stretched.
// Longer than 4 weeks is not offered: stored history is too short to validate it.
let fc = '1w';
// 'jittery' draws one erratic path per side; 'smooth' draws the average line (what the backtest scores).
const LINE_KEY = 'lucrum.forecastLine';
let lineMode = (() => { try { return localStorage.getItem(LINE_KEY) === 'smooth' ? 'smooth' : 'jittery'; } catch (err) { return 'jittery'; } })();
// Which forecast model draws the chart and the replays (worker quant/models.js), and which one, if
// any, is drawn faintly beside it for comparison.
let model = 'pred-10';
let compareWith = '';
let view = null; // { min, max } – the visible time window once the reader has zoomed or panned
let backtestAt = null; // { from, body } – a replay drawn on the chart
let interactAbort = null; // removes the previous chart's pointer handlers on a rebuild
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
function chromePlugin(nowRef, events, btRef) {
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

      if (btRef.from !== null) {
        const bx = x.getPixelForValue(btRef.from);
        if (bx >= chartArea.left && bx <= chartArea.right) {
          ctx.setLineDash([2, 3]);
          ctx.strokeStyle = colours.accent;
          ctx.beginPath();
          ctx.moveTo(bx, chartArea.top);
          ctx.lineTo(bx, chartArea.bottom);
          ctx.stroke();
          ctx.fillStyle = colours.accent;
          ctx.font = '10px "JetBrains Mono", monospace';
          ctx.fillText('replay from here', bx + 4, chartArea.top + 11);
        }
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

/** The forecast as drawn: one erratic path per side (quant/predict.js examplePaths()) – the smooth
 * average plus this item's own kind of moves, so it looks like a real price would. */
function pathSets(paths, buyCurve, sellCurve, at, buy, sell, prefix) {
  const p = (paths || [])[0];
  if (!p) return [];
  const style = { borderWidth: 1.5, pointRadius: 0, tension: 0, borderDash: prefix ? [2, 3] : [5, 4], glow: prefix ? 0 : 10 };
  return [
    { label: `${prefix}${prefix ? 'buy' : 'Buy'} forecast`, data: p.buy.map((y, i) => ({ x: at(buyCurve[i]), y })), borderColor: buy, ...style },
    { label: `${prefix}${prefix ? 'sell' : 'Sell'} forecast`, data: p.sell.map((y, i) => ({ x: at(sellCurve[i]), y })), borderColor: sell, ...style },
  ];
}
function pushPaths(datasets, ...args) { datasets.push(...pathSets(...args)); }

// One tooltip row per line, each taken at the point nearest the pointer on that line's own time
// axis. The built-in 'index' mode pairs points by array position, which is wrong the moment lines
// (history, forecast, a replay) do not share their time points.
if (window.Chart && Chart.Interaction) {
  Chart.Interaction.modes.lucrumX = (c, e) => {
    const xv = c.scales.x.getValueForPixel(e.x);
    const items = [];
    c.data.datasets.forEach((ds, di) => {
      const pts = ds.data;
      if (!c.isDatasetVisible(di) || !pts.length) return;
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.abs(pts[i].x - xv);
        if (d < bd) { bd = d; best = i; }
      }
      const tol = pts.length > 1 ? 1.5 * Math.abs(pts[1].x - pts[0].x) : Infinity;
      if (bd <= tol) items.push({ element: c.getDatasetMeta(di).data[best], datasetIndex: di, index: best });
    });
    return items;
  };
}

/** Fits the price axis to what is in the visible time window, so zooming in shows the detail. */
function fitY() {
  const sx = chart.options.scales.x;
  let lo = Infinity;
  let hi = -Infinity;
  for (const ds of chart.data.datasets) {
    if (ds.label.includes('range band')) continue;
    for (const p of ds.data) {
      if (p.x < sx.min || p.x > sx.max || !Number.isFinite(p.y)) continue;
      if (p.y < lo) lo = p.y;
      if (p.y > hi) hi = p.y;
    }
  }
  const sy = chart.options.scales.y;
  if (lo === Infinity) { delete sy.min; delete sy.max; return; }
  const pad = (hi - lo || hi * 0.02 || 1) * 0.06;
  sy.min = lo - pad;
  sy.max = hi + pad;
}

/** Wheel / pinch zooms, drag pans, double-click resets, and a click (no drag) on the past runs a
 * backtest from there. Pointer events cover mouse, pen and touch; the canvas leaves vertical
 * swipes to the page (touch-action: pan-y) so scrolling past the chart still works on a phone. */
function attachInteractions(canvas, limits, home) {
  if (interactAbort) interactAbort.abort();
  interactAbort = new AbortController();
  const opts = { signal: interactAbort.signal };
  const pts = new Map();
  let drag = null;
  let pinch = null;

  const current = () => ({ min: chart.options.scales.x.min, max: chart.options.scales.x.max });
  const clamp = (min, max) => {
    const span = Math.min(Math.max(max - min, limits.minSpan), limits.max - limits.min);
    let lo = min;
    if (lo < limits.min) lo = limits.min;
    if (lo + span > limits.max) lo = limits.max - span;
    return { min: lo, max: lo + span };
  };
  const apply = (v) => {
    view = v;
    chart.options.scales.x.min = v.min;
    chart.options.scales.x.max = v.max;
    fitY();
    chart.update('none');
  };
  const zoomAround = (t, factor, base) => {
    const lo = t - (t - base.min) * factor;
    apply(clamp(lo, lo + (base.max - base.min) * factor));
  };
  const timeAt = (clientX) => chart.scales.x.getValueForPixel(clientX - canvas.getBoundingClientRect().left);
  const msPerPx = (v) => (v.max - v.min) / chart.chartArea.width;

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const v = current();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = (e.deltaX || e.deltaY) * msPerPx(v);
      apply(clamp(v.min + d, v.max + d));
      return;
    }
    zoomAround(timeAt(e.clientX), Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 100) * 0.002), v);
  }, { ...opts, passive: false });

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX });
    if (pts.size === 1) {
      drag = { x0: e.clientX, base: current(), moved: false };
      pinch = null;
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d0: Math.abs(a.x - b.x) || 1, base: current(), t: timeAt((a.x + b.x) / 2) };
      drag = null;
    }
  }, opts);

  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX });
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      zoomAround(pinch.t, pinch.d0 / (Math.abs(a.x - b.x) || 1), pinch.base);
    } else if (drag) {
      const dx = e.clientX - drag.x0;
      if (Math.abs(dx) > 5) drag.moved = true;
      if (drag.moved) {
        const d = -dx * msPerPx(drag.base);
        apply(clamp(drag.base.min + d, drag.base.max + d));
      }
    }
  }, opts);

  const end = (e) => {
    const wasClick = drag && !drag.moved && pts.size === 1 && e.type === 'pointerup';
    pts.delete(e.pointerId);
    if (wasClick) onChartClick(timeAt(e.clientX));
    if (pts.size === 0) { drag = null; pinch = null; }
  };
  canvas.addEventListener('pointerup', end, opts);
  canvas.addEventListener('pointercancel', end, opts);

  canvas.addEventListener('dblclick', () => {
    view = null;
    apply(home);
    view = null;
  }, opts);
}

function buildChart({ history, predict, compare }) {
  const bars = history.bars || [];
  const now = predict ? predict.now : Date.now();
  const futureMs = predict ? predict.futureMs : backtestHorizonMs(fc);
  const windowStart = now - rangeWindowMs(range);
  const windowEnd = now + futureMs;
  const limits = {
    min: bars.length ? Math.min(bars[0].t, windowStart) : windowStart,
    max: windowEnd,
    minSpan: RANGE_BAR_MS[range] * 8,
  };
  const visibleSpan = () => (view ? view.max - view.min : windowEnd - windowStart);

  const buy = cssVar('--buy');
  const sell = cssVar('--sell');
  const line = cssVar('--line');
  const lineStrong = cssVar('--line-strong');
  const text = cssVar('--text');
  const textDim = cssVar('--text-3');
  const surface = cssVar('--surface');

  // Each bar's high-low range, faint behind the lines: a resting order fills only if the range reached it.
  const hl = { pointRadius: 0, borderWidth: 0, borderColor: 'transparent', tension: 0.1, spanGaps: true };
  const datasets = [
    { label: 'Buy range band hi', data: bars.map((b) => ({ x: b.t, y: b.bh })), ...hl },
    { label: 'Buy range band lo', data: bars.map((b) => ({ x: b.t, y: b.bl })), ...hl, fill: '-1', backgroundColor: withAlpha(buy, 0.07) },
    { label: 'Sell range band hi', data: bars.map((b) => ({ x: b.t, y: b.sh })), ...hl },
    { label: 'Sell range band lo', data: bars.map((b) => ({ x: b.t, y: b.sl })), ...hl, fill: '-1', backgroundColor: withAlpha(sell, 0.07) },
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
    );
    if (lineMode === 'smooth' || !(predict.paths || []).length) {
      const style = { borderWidth: 1.5, pointRadius: 0, tension: 0.15, borderDash: [5, 4], glow: 10 };
      datasets.push(
        { label: 'Buy forecast', data: predict.buy.map((p) => ({ x: at(p), y: p.p })), borderColor: buy, ...style },
        { label: 'Sell forecast', data: predict.sell.map((p) => ({ x: at(p), y: p.p })), borderColor: sell, ...style },
      );
    } else {
      pushPaths(datasets, predict.paths, predict.buy, predict.sell, at, buy, sell, '');
    }
  }

  // Another model's average line, faint, for comparison – from the same moment, same horizon.
  const legendCompare = document.getElementById('legend-compare');
  if (legendCompare) {
    legendCompare.hidden = !(compare && compare.buy);
    if (compare) document.getElementById('legend-compare-name').textContent = compare.modelVersion;
  }
  if (compare && compare.buy) {
    const at = (p) => compare.now + p.t;
    const faint = { borderWidth: 1.25, pointRadius: 0, tension: 0.15, borderDash: [2, 2] };
    datasets.push(
      { label: `${compare.modelVersion} buy forecast`, data: compare.buy.map((p) => ({ x: at(p), y: p.p })), borderColor: withAlpha(buy, 0.45), ...faint },
      { label: `${compare.modelVersion} sell forecast`, data: compare.sell.map((p) => ({ x: at(p), y: p.p })), borderColor: withAlpha(sell, 0.45), ...faint },
    );
  }

  const bt = backtestAt;
  if (bt) {
    // The replayed forecast, dotted, from the clicked moment – next to the real lines that followed
    // it, and the flat "price stays put" baseline it is scored against.
    const b = bt.body;
    const atb = (p) => b.from + p.t;
    const flat = (y) => [{ x: b.from, y }, { x: b.from + b.futureMs, y }];
    const dot = { pointRadius: 0, borderWidth: 1.75, borderDash: [2, 3], tension: 0.15 };
    if (bt.compare && bt.compare.predicted) {
      const c = bt.compare;
      const atc = (p) => c.from + p.t;
      const faint = { borderWidth: 1.25, pointRadius: 0, tension: 0.15, borderDash: [1, 2] };
      datasets.push(
        { label: `Backtest ${c.modelVersion} buy forecast`, data: c.predicted.buy.map((p) => ({ x: atc(p), y: p.p })), borderColor: withAlpha(buy, 0.45), ...faint },
        { label: `Backtest ${c.modelVersion} sell forecast`, data: c.predicted.sell.map((p) => ({ x: atc(p), y: p.p })), borderColor: withAlpha(sell, 0.45), ...faint },
      );
    }
    datasets.push(
      { label: 'Backtest buy band hi', data: b.predicted.buy.map((p) => ({ x: atb(p), y: p.hi })), ...hl },
      { label: 'Backtest buy band lo', data: b.predicted.buy.map((p) => ({ x: atb(p), y: p.lo })), ...hl, fill: '-1', backgroundColor: withAlpha(buy, 0.07) },
      { label: 'Backtest sell band hi', data: b.predicted.sell.map((p) => ({ x: atb(p), y: p.hi })), ...hl },
      { label: 'Backtest sell band lo', data: b.predicted.sell.map((p) => ({ x: atb(p), y: p.lo })), ...hl, fill: '-1', backgroundColor: withAlpha(sell, 0.07) },
      ...(lineMode === 'smooth' || !(b.paths || []).length ? [
        { label: 'Backtest buy forecast', data: b.predicted.buy.map((p) => ({ x: atb(p), y: p.p })), borderColor: buy, ...dot, borderWidth: 1.5 },
        { label: 'Backtest sell forecast', data: b.predicted.sell.map((p) => ({ x: atb(p), y: p.p })), borderColor: sell, ...dot, borderWidth: 1.5 },
      ] : pathSets(b.paths, b.predicted.buy, b.predicted.sell, atb, buy, sell, 'Backtest ')),
      { label: 'Flat baseline buy', data: flat(b.naive.buy), borderColor: textDim, pointRadius: 0, borderWidth: 1, borderDash: [1, 3] },
      { label: 'Flat baseline sell', data: flat(b.naive.sell), borderColor: textDim, pointRadius: 0, borderWidth: 1, borderDash: [1, 3] },
    );
  }

  const events = predict ? (predict.events || []) : [];

  // buildTime anchors the ticker below: it advances `now` by wall-clock time elapsed since this
  // chart was built, rather than re-reading Date.now() outright, so a client/worker clock skew
  // shows up as a constant (harmless) offset instead of a jump each time the marker ticks.
  const buildTime = Date.now();
  const nowRef = { value: now };

  // Where the pointer is, so the tooltip can tell the past from the future. Index-mode picks the
  // nearest point on every line, so without this a past date also listed the first forecast point.
  let hoverX = null;

  const btRef = { from: bt ? bt.body.from : null };
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
      interaction: { mode: 'lucrumX', intersect: false },
      onHover: (event) => { hoverX = event.x; },
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
          // History lines only up to "now", forecast lines only after it, a replay only after the
          // moment it started from, and never the band edges.
          filter: (item) => {
            const label = item.dataset.label;
            if (label.includes('band')) return false;
            const at = hoverX === null ? null : item.chart.scales.x.getValueForPixel(hoverX);
            if (at === null || at === undefined) return true;
            if (label.startsWith('Backtest') || label.startsWith('Flat baseline')) return btRef.from !== null && at >= btRef.from;
            return label.includes('forecast') || label.includes('average') ? at >= nowRef.value : at <= nowRef.value;
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: view ? view.min : windowStart,
          max: view ? view.max : windowEnd,
          grid: { color: line, drawTicks: false },
          border: { color: line },
          ticks: {
            color: textDim, maxTicksLimit: 8, autoSkip: true,
            font: { family: '"JetBrains Mono", monospace', size: 10 },
            callback: (v) => tickFormat(v, visibleSpan()),
          },
        },
        y: {
          grid: { color: line, drawTicks: false },
          border: { color: line },
          ticks: {
            color: textDim,
            font: { family: '"JetBrains Mono", monospace', size: 10 },
            // Compact labels collapse to the same "1.3k" when prices sit close together; then show coins.
            callback: (v, i, ticks) => (ticks.length > 1 && ticks.at(-1).value - ticks[0].value < Math.abs(v) * 0.3 ? formatCoins(v) : formatCompact(v)),
          },
        },
      },
    },
    plugins: [glowPlugin(), chromePlugin(nowRef, events, btRef)],
  });
  fitY();
  chart.update('none');
  attachInteractions(canvas, limits, { min: windowStart, max: windowEnd });

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
    if (b.shape === 'learned') return `learned from every item's history, blended with this item's own${b.events ? ', reading the upcoming events that touch it' : ''} – ${formatPct(b.improvement, 1)} less error than a flat line over 5 days on a month it never saw`;
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
      The drawn line is one way the price could go: a smooth average plus this item's own kind of
      jumps, replayed from its recent history. The jumps show how rough the price is; their timing is
      not a prediction. Switch the line to Smooth to see the average under them, which is what the
      backtest scores.
      It comes from a model trained on the history of hundreds of items at once: it weighs where the
      price sits against its levels over the last 12 hours to 30 days, recent momentum and
      volatility, the spread, the order book and weekly volume, the other side's price and the time
      of day, and learns how those combinations moved prices afterwards. That is averaged with this
      item's own-history model and pulled toward the last price over the next few hours, where
      neither model beats "it stays here". The shaded band is the middle half of what followed
      similar moments: about half of prices should land inside it.
      Items with under about four days of history fall back to their own-history model.
      When a calendar event touches this item inside the forecast (a Mining Fiesta for gemstones, a
      Fishing Festival for sea creature drops…), a version of the model that also reads when events
      start and end takes over for those hours – it learned their effect from past events, and on a
      month it never saw it did slightly better there and slightly worse elsewhere. Confidence falls when history is thin relative to the horizon or when
      the price jumps a lot.
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
  const horizon = formatDuration(backtestHorizonMs(fc));
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
  btn.addEventListener('click', () => {
    // One forecast length back from now; the replay always runs to the present.
    runBacktestAt(Date.now() - backtestHorizonMs(fc));
  });
}

/** Replays the forecast from `t` (a moment the reader clicked, or the latest scoreable one) and
 * draws it on the chart. `range=fc` names the same model tier the live forecast uses. */
async function runBacktestAt(t) {
  const note = document.getElementById('bt-note');
  const btn = document.getElementById('backtest-btn');
  const step = RANGE_BAR_MS[fc];
  const from = Math.floor(t / step) * step; // bar-aligned, so nearby clicks share a cached run
  const to = Math.floor(Date.now() / step) * step; // always replayed up to the present
  if (to - from < 3 * step) {
    if (note) note.textContent = 'That is too close to now to replay – click further back.';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
  if (note) note.textContent = `Replaying the forecast from ${formatLocalTime(from)}…`;
  try {
    const { status, body } = await callWorker(`/backtest?item=${encodeURIComponent(itemId)}&from=${from}&to=${to}&range=${fc}&model=${model}`);
    if (status !== 200) {
      const kind = classifyFailure(null, body) || 'unknown';
      if (note) note.textContent = failureText(kind, { item: itemId, range: fc });
      return;
    }
    // The Compare model replayed from the same moment, drawn faintly beside it and scored too.
    let other = null;
    if (compareWith && compareWith !== model) {
      try {
        const res = await callWorker(`/backtest?item=${encodeURIComponent(itemId)}&from=${from}&to=${to}&range=${fc}&model=${compareWith}`);
        if (res.status === 200) other = res.body;
      } catch (err) { other = null; }
    }
    backtestAt = { from: body.from, body, compare: other };
    if (lastPayload) buildChart(lastPayload);
    const m = body.metrics || {};
    const om = other ? other.metrics || {} : null;
    if (note) {
      note.innerHTML = `Replay from <strong>${esc(formatLocalTime(body.from))}</strong> over ${esc(formatDuration(body.futureMs))}: ${
        m.skill === null || m.skill === undefined ? 'skill undefined' : `${esc(body.modelVersion || model)}'s average line scored <span class="${signClass(m.skill)}">${esc(formatPctSigned(m.skill))}</span> vs staying flat`
      }${om && om.skill !== null && om.skill !== undefined ? `, ${esc(other.modelVersion)} <span class="${signClass(om.skill)}">${esc(formatPctSigned(om.skill))}</span>` : ''}. <button class="btn btn-sm" id="bt-clear" type="button">Clear</button>`;
      document.getElementById('bt-clear').addEventListener('click', clearBacktest);
    }
    renderBacktest(body);
  } catch (err) {
    if (note) note.textContent = failureText('unreachable');
  } finally {
    const b2 = document.getElementById('backtest-btn');
    if (b2) { b2.disabled = false; b2.textContent = backtestButtonLabel(backtestHasRun); }
  }
}

function clearBacktest() {
  backtestAt = null;
  const note = document.getElementById('bt-note');
  if (note) note.textContent = '';
  if (lastPayload) buildChart(lastPayload);
}

/** A click on the chart: only the past can be replayed. */
function onChartClick(t) {
  const note = document.getElementById('bt-note');
  if (!lastPayload || !lastPayload.predict) return;
  if (t >= lastPayload.predict.now) {
    if (note) note.textContent = 'Click a point in the past – a replay needs what happened after it.';
    return;
  }
  runBacktestAt(t);
}

/* --- Load ---------------------------------------------------------------------------------------- */

function setRangePressed() {
  rangeTabs.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
  forecastTabs.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fc === fc)));
}

function chartShell() {
  chartCard.innerHTML = `
    <div class="chart-wrap"><canvas id="chart"></canvas></div>
    <div class="chart-legend">
      <span class="buy-c"><span class="swatch" style="background:var(--buy)"></span>Buy side</span>
      <span class="sell-c"><span class="swatch" style="background:var(--sell)"></span>Sell side</span>
      <span><span class="swatch dashed"></span>Forecast</span>
      <span><span class="swatch" style="background:var(--line-strong)"></span>Middle half of outcomes</span>
      <span id="legend-compare" hidden><span class="swatch dashed"></span><span id="legend-compare-name"></span> forecast, faint</span>
      <span><span class="swatch" style="background:var(--line)"></span>High–low range of each bar</span>
    </div>
    <p class="chart-hint">Scroll or pinch to zoom, drag to pan, double-click to reset. Click any point in the past to replay the forecast from there.</p>
    <p class="bt-note" id="bt-note"></p>`;
}

/** The comparison model's forecast, or null when none is picked or it is the one already drawn. */
async function loadCompare() {
  if (!compareWith || compareWith === model) return null;
  try {
    const res = await callWorker(`/predict?item=${encodeURIComponent(itemId)}&range=${fc}&model=${compareWith}`);
    return res.status === 200 ? res.body : null;
  } catch (err) {
    return null;
  }
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
      callWorker(`/predict?item=${encodeURIComponent(itemId)}&range=${fc}&model=${model}`),
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
  lastPayload = { history: history || { bars: [] }, predict, compare: await loadCompare() };
  buildChart(lastPayload);

  if (predict) {
    renderModel(predict, history);
    renderEvents(predict);
  } else {
    const kind = classifyFailure(null, predictRes.body) || 'unknown';
    modelBody.innerHTML = `<p class="dim" style="margin:0">${esc(failureText(kind, { item: itemId, range: fc }))}</p>`;
    eventsBody.innerHTML = '<p class="dim" style="margin:0">Event marks come with the prediction, which is unavailable for this range.</p>';
  }
}

rangeTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    range = btn.dataset.range;
    view = null;
    backtestAt = null;
    setRangePressed();
    loadChart();
  });
});
forecastTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    fc = btn.dataset.fc;
    view = null;
    backtestAt = null;
    setRangePressed();
    refreshBacktestButtonLabel();
    loadChart();
  });
});
// Model choice refetches the forecast (and drops a replay made with the old one); the comparison
// line is fetched on its own and only redraws.
const setModelPressed = () => modelTabs.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.model === model)));
modelTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.model === model) return;
    model = btn.dataset.model;
    backtestAt = null;
    setModelPressed();
    loadChart();
  });
});
compareSelect.addEventListener('change', async () => {
  compareWith = compareSelect.value;
  if (!lastPayload) return;
  lastPayload.compare = await loadCompare();
  buildChart(lastPayload);
  if (backtestAt) runBacktestAt(backtestAt.from);
});

// Smooth or jittery forecast line: a redraw of what is already loaded, remembered for next time.
const setLinePressed = () => lineTabs.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.line === lineMode)));
setLinePressed();
lineTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    lineMode = btn.dataset.line;
    try { localStorage.setItem(LINE_KEY, lineMode); } catch (err) { /* no persistence available */ }
    setLinePressed();
    if (lastPayload) buildChart(lastPayload);
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
