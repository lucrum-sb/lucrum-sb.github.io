// Item detail page – the signature element (docs/BRAND.md candidate #1): a single hairline chart,
// live, quiet, brass-on-panel, styled to the token palette rather than reusing SeyVault's glow
// plugin. Combines GET /history and GET /predict per docs/CONTRACTS.md's chart window contract.
// No chart maths beyond drawing – the worker already returns downsampled, windowed data.
import { callWorker, WorkerUnreachableError } from './api.js';
import { renderErrorState, classifyFailure } from './errors.js';
import { formatCoins, formatPct, itemLabel, formatLocalTime } from './format.js';

const toggle = document.getElementById('theme-toggle');
function syncToggleLabel() {
  toggle.textContent = window.LucrumTheme.current() === 'dark' ? 'Light mode' : 'Dark mode';
}
syncToggleLabel();

const params = new URLSearchParams(window.location.search);
const itemId = params.get('id') || params.get('item');
const title = document.getElementById('item-title');
const chartCard = document.getElementById('chart-card');
const confidenceNote = document.getElementById('confidence-note');
const eventNotes = document.getElementById('event-notes');
const rangeTabs = document.querySelectorAll('#range-tabs .type-tab');

title.textContent = itemId ? itemLabel(itemId) : 'No item selected';

let chart = null;
let range = '1d';

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function tickFormat(ts, spanMs) {
  const d = new Date(ts);
  if (spanMs <= 26 * 3600000) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Draws a solid "now" hairline and dashed event marks – Chart.js plugin API, no external
 * annotation plugin, so the visual weight stays exactly what docs/BRAND.md specifies. */
function chromePlugin(nowTs, events) {
  return {
    id: 'lucrumChrome',
    afterDraw(c) {
      const { ctx, chartArea, scales } = c;
      const x = scales.x;
      if (!x || !chartArea) return;
      ctx.save();

      // "Now" line, solid brass.
      const nowPx = x.getPixelForValue(nowTs);
      if (nowPx >= chartArea.left && nowPx <= chartArea.right) {
        ctx.strokeStyle = cssVar('--brass');
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(nowPx, chartArea.top);
        ctx.lineTo(nowPx, chartArea.bottom);
        ctx.stroke();
      }

      // Event marks, dashed hairline, per docs/CONTRACTS.md's `/predict` events array.
      ctx.setLineDash([3, 3]);
      ctx.font = '11px Inter, system-ui, sans-serif';
      for (const ev of events) {
        const px = x.getPixelForValue(ev.t);
        if (px < chartArea.left || px > chartArea.right) continue;
        ctx.strokeStyle = cssVar('--hairline');
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.moveTo(px, chartArea.top);
        ctx.lineTo(px, chartArea.bottom);
        ctx.stroke();
        ctx.fillStyle = cssVar('--text-dim');
        ctx.save();
        ctx.translate(px + 4, chartArea.top + 10);
        ctx.rotate(0);
        ctx.fillText(ev.fitted === false ? `${ev.label} (unfitted)` : ev.label, 0, 0);
        ctx.restore();
      }
      ctx.setLineDash([]);
      ctx.restore();
    },
  };
}

function buildChart(history, predict) {
  const now = predict.now;
  const bars = history.bars || [];
  const buyHist = bars.map((b) => ({ x: b.t, y: b.bc }));
  const sellHist = bars.map((b) => ({ x: b.t, y: b.sc }));

  const buyPred = predict.buy.map((p) => ({ x: now + p.t, y: p.p }));
  const sellPred = predict.sell.map((p) => ({ x: now + p.t, y: p.p }));
  const buyLo = predict.buy.map((p) => ({ x: now + p.t, y: p.lo }));
  const buyHi = predict.buy.map((p) => ({ x: now + p.t, y: p.hi }));
  const sellLo = predict.sell.map((p) => ({ x: now + p.t, y: p.lo }));
  const sellHi = predict.sell.map((p) => ({ x: now + p.t, y: p.hi }));

  const spanMs = bars.length > 1 ? bars[bars.length - 1].t - bars[0].t : 3600000;
  const events = (predict.events || []).map((e) => ({ ...e }));

  const brass = cssVar('--brass');
  const brassDim = cssVar('--brass-dim');
  const gain = cssVar('--gain');
  const loss = cssVar('--loss');
  const text = cssVar('--text');
  const textDim = cssVar('--text-dim');
  const hairline = cssVar('--hairline');

  const bandOpts = { pointRadius: 0, borderWidth: 0, fill: false, tension: 0.15 };

  const datasets = [
    { label: 'Buy history', data: buyHist, borderColor: gain, borderWidth: 1.25, pointRadius: 0, tension: 0.1 },
    { label: 'Sell history', data: sellHist, borderColor: loss, borderWidth: 1.25, pointRadius: 0, tension: 0.1 },
    { label: 'Buy uncertainty hi', data: buyHi, ...bandOpts, borderColor: 'transparent' },
    { label: 'Buy uncertainty lo', data: buyLo, ...bandOpts, borderColor: 'transparent', fill: '-1', backgroundColor: `${brassDim}33` },
    { label: 'Sell uncertainty hi', data: sellHi, ...bandOpts, borderColor: 'transparent' },
    { label: 'Sell uncertainty lo', data: sellLo, ...bandOpts, borderColor: 'transparent', fill: '-1', backgroundColor: `${brassDim}33` },
    { label: 'Buy prediction', data: buyPred, borderColor: brass, borderDash: [5, 3], borderWidth: 1.5, pointRadius: 0, tension: 0.15 },
    { label: 'Sell prediction', data: sellPred, borderColor: brass, borderDash: [2, 2], borderWidth: 1.5, pointRadius: 0, tension: 0.15 },
  ];

  if (chart) chart.destroy();
  const canvas = document.getElementById('chart');
  chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cssVar('--panel'),
          titleColor: text,
          bodyColor: textDim,
          borderColor: hairline,
          borderWidth: 1,
          callbacks: {
            title: (items) => (items[0] ? formatLocalTime(items[0].parsed.x) : ''),
            label: (item) => `${item.dataset.label}: ${formatCoins(item.parsed.y)}`,
          },
          filter: (item) => !item.dataset.label.includes('uncertainty'),
        },
      },
      scales: {
        x: {
          type: 'linear',
          grid: { color: hairline, drawTicks: false },
          border: { color: hairline },
          ticks: { color: textDim, callback: (v) => tickFormat(v, spanMs), maxTicksLimit: 8 },
        },
        y: {
          grid: { color: hairline, drawTicks: false },
          border: { color: hairline },
          ticks: { color: textDim, callback: (v) => formatCoins(v) },
        },
      },
    },
    plugins: [chromePlugin(now, events)],
  });

  confidenceNote.textContent = `Model confidence: ${formatPct(predict.confidence)}. Confidence falls when history is thin relative to the horizon, or when an unfitted event effect bends the curve materially.`;

  eventNotes.innerHTML = '';
  const unfitted = events.filter((e) => e.fitted === false);
  if (unfitted.length) {
    const p = document.createElement('p');
    p.className = 'caveat';
    p.textContent = `${unfitted.map((e) => e.label).join(', ')}: modelled with a conservative placeholder magnitude, not one measured from stored history.`;
    eventNotes.appendChild(p);
  }
}

async function load() {
  if (!itemId) {
    renderErrorState(chartCard, 'item_not_found');
    return;
  }
  chartCard.hidden = false;
  let historyRes, predictRes;
  try {
    [historyRes, predictRes] = await Promise.all([
      callWorker(`/history?item=${encodeURIComponent(itemId)}&range=${range}`),
      callWorker(`/predict?item=${encodeURIComponent(itemId)}&range=${range}`),
    ]);
  } catch (err) {
    if (err instanceof WorkerUnreachableError) {
      renderErrorState(chartCard, 'unreachable');
      return;
    }
    throw err;
  }

  if (historyRes.status !== 200) {
    renderErrorState(chartCard, classifyFailure(null, historyRes.body) || 'unknown', { item: itemId });
    return;
  }
  if (predictRes.status !== 200) {
    renderErrorState(chartCard, classifyFailure(null, predictRes.body) || 'unknown', { item: itemId });
    return;
  }

  // Rebuild chart-card innards in case a previous range failed and replaced them with an error.
  if (!document.getElementById('chart')) {
    chartCard.innerHTML = `
      <div class="chart-wrap"><canvas id="chart"></canvas></div>
      <div class="chart-legend">
        <span><span class="swatch" style="background:var(--gain)"></span>Buy side (history)</span>
        <span><span class="swatch" style="background:var(--loss)"></span>Sell side (history)</span>
        <span><span class="swatch" style="background:var(--brass)"></span>Prediction</span>
        <span><span class="swatch" style="background:var(--brass-dim)"></span>Uncertainty band</span>
      </div>
    `;
  }
  buildChart(historyRes.body, predictRes.body);
}

rangeTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    range = btn.dataset.range;
    rangeTabs.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    load();
  });
});

toggle.addEventListener('click', () => {
  window.LucrumTheme.toggle();
  syncToggleLabel();
  if (chart) load(); // re-theme by rebuilding with the new CSS variable values
});

load();
