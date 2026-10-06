// Models – GET /models: every forecast model the worker runs, what each reads, how it was trained,
// and a head-to-head on the same held-out forecasts (docs/CONTRACTS.md). Like the Status page it
// states results as they are: a tie is called a tie, and a model that loses somewhere says where.
import { callWorker } from './api.js';
import { renderErrorState, classifyFailure } from './errors.js';
import { formatInt, formatCompact, formatLocalTime, formatAge, formatPct, formatPctSigned, signClass, esc } from './format.js';

const body = document.getElementById('models-body');
let chart = null;
let payload = null;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** One colour per model, newest brightest. */
function modelColours() {
  return { 'pred-10': cssVar('--accent'), 'pred-9': cssVar('--buy'), 'pred-8': cssVar('--sell'), 'pred-7': cssVar('--text-3') };
}

const day = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '–');

function card(m) {
  const t = m.training;
  return `
    <div class="card model-card${m.isDefault ? ' is-default' : ''}">
      <div class="model-card-head">
        <h2>${esc(m.id)}</h2>
        ${m.isDefault ? '<span class="chip chip-accent">Default</span>' : ''}
      </div>
      <p class="dimmer model-meta">Released ${esc(day(Date.parse(m.released)))}${t ? ` · ${formatInt(t.inputs)} inputs · ${formatInt(t.trees)} trees` : ' · no learned trees'}</p>
      <p class="model-summary">${esc(m.summary)}</p>
      <dl class="model-notes">
        <dt>Better at</dt><dd>${esc(m.strengths)}</dd>
        <dt>Worse at</dt><dd>${esc(m.weaknesses)}</dd>
      </dl>
    </div>`;
}

/** A metric row across models, the best value marked. `higher` says which way is better. */
function metricRow(label, values, fmt, higher = true, note = '') {
  const finite = values.filter((v) => v !== null && v !== undefined);
  // `higher` null: neither way is better (a count, or band coverage aimed at 50%), so nothing is marked.
  const best = finite.length && higher !== null ? (higher ? Math.max(...finite) : Math.min(...finite)) : null;
  return `<tr><td class="key">${esc(label)}${note ? `<span class="dimmer row-note">${esc(note)}</span>` : ''}</td>${values.map((v) =>
    `<td class="num${v !== null && v !== undefined && v === best && finite.length > 1 ? ' best' : ''}">${v === null || v === undefined ? '–' : fmt(v)}</td>`).join('')}</tr>`;
}

function benchmarks(cmp, ids) {
  const B = cmp.buckets;
  // pred-7 is only scored up to 5 days, so a bucket that runs past that would compare it on easier
  // forecasts than the others – it shows a dash there instead.
  const PARTIAL_FOR_PRED7 = new Set(['All look-aheads', 'Top 80 traded items']);
  const get = (bucket, id, key) => (id === 'pred-7' && PARTIAL_FOR_PRED7.has(bucket) ? null : B[bucket]?.[id]?.[key] ?? null);
  const pct = (v) => formatPctSigned(v, 1);
  const share = (v) => formatPct(v, 1);
  const skillRows = [
    ['Up to 5 days', 'Up to 5 days (all four models)', 'the only stretch every model covers'],
    ['All look-aheads', 'All look-aheads', '2 hours to 14 days'],
    ['Up to 12 hours', 'Up to 12 hours', ''],
    ['12 hours to 2 days', '12 hours to 2 days', ''],
    ['2 to 5 days', '2 to 5 days', ''],
    ['Over 5 days', 'Over 5 days', 'up to 14 days'],
    ['Top 80 traded items', 'Top 80 traded items', 'by coins traded'],
  ];
  const all = 'Up to 5 days (all four models)';
  return `
    <div class="table-wrap"><div class="table-scroll"><table class="ledger bench">
      <thead><tr><th>Skill vs a flat price</th>${ids.map((id) => `<th class="num">${esc(id)}</th>`).join('')}</tr></thead>
      <tbody>
        ${skillRows.map(([label, bucket, note]) => metricRow(label, ids.map((id) => get(bucket, id, 'skill')), pct, true, note)).join('')}
      </tbody>
      <thead><tr><th>Other measures (up to 5 days, all four models)</th>${ids.map(() => '<th></th>').join('')}</tr></thead>
      <tbody>
        ${metricRow('Direction right', ids.map((id) => get(all, id, 'direction')), share, true, 'when it calls a move over 1%')}
        ${metricRow('Direction right on big moves', ids.map((id) => get(all, id, 'bigDirection')), share, true, 'moves over 10%')}
        ${metricRow('Typical error', ids.map((id) => get(all, id, 'mae')), share, false, 'mean distance from the real price')}
        ${metricRow('Outcomes inside the band', ids.map((id) => get(all, id, 'band')), share, null, 'aim: about 50% – pred-7 has no comparable band')}
        ${metricRow('Forecasts scored', ids.map((id) => get(all, id, 'n')), (v) => formatCompact(v), null)}
      </tbody>
    </table></div></div>`;
}

function inputsTable(inputs, ids) {
  const cell = (v) => (v === true ? '<span class="pos">✓</span>' : v === false || v === undefined ? '<span class="dimmer">–</span>' : `<span class="dim">${esc(v)}</span>`);
  return `
    <div class="table-wrap"><div class="table-scroll"><table class="ledger dense">
      <thead><tr><th>Reads</th>${ids.map((id) => `<th class="num">${esc(id)}</th>`).join('')}</tr></thead>
      <tbody>${inputs.map((r) => `<tr><td class="key">${esc(r.label)}</td>${ids.map((id) => `<td class="num">${cell(r.by[id])}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div></div>`;
}

function trainingTable(models) {
  const rows = [
    ['Items', (t) => formatInt(t.items)],
    ['Training examples', (t) => formatCompact(t.examples)],
    ['History', (t) => `${esc(day(t.from))} – ${esc(day(t.to))}`],
    ['Inputs', (t) => formatInt(t.inputs)],
    ['Trees', (t) => `${formatInt(t.trees)}${t.sets > 1 ? ` in ${t.sets} sets` : ''}`],
    ['Look-aheads learned', (t) => formatInt(t.lookaheads)],
  ];
  return `
    <div class="table-wrap"><div class="table-scroll"><table class="ledger dense">
      <thead><tr><th></th>${models.map((m) => `<th class="num">${esc(m.id)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(([label, f]) => `<tr><td class="key">${label}</td>${models.map((m) => `<td class="num">${m.training ? f(m.training) : '<span class="dimmer">own history only</span>'}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div></div>`;
}

function liveSection(live, at) {
  if (!live || !live.summary || !live.summary.scored) {
    return `<p class="dim" style="margin:0">The daily check only scores forecasts made after the default model's training data ends${live && live.trainedTo ? ` (${esc(formatLocalTime(live.trainedTo))})` : ''}, once their whole horizon has played out – the first scores appear a few days after a release.</p>`;
  }
  const m = live.summary;
  const base = live.baseline && live.baseline.summary;
  return `
    <div class="grid grid-3">
      <div class="stat"><span class="label">${esc(live.modelVersion)} skill</span><span class="value ${signClass(m.skill)}">${formatPctSigned(m.skill, 1)}</span><p class="note">vs a flat price, ${formatInt(m.scored)} runs</p></div>
      ${base ? `<div class="stat"><span class="label">pred-7, same windows</span><span class="value ${signClass(base.skill)}">${formatPctSigned(base.skill, 1)}</span></div>` : ''}
      <div class="stat"><span class="label">Direction right</span><span class="value">${formatPct(m.directionalAccuracy, 0)}</span></div>
    </div>
    <p class="dimmer" style="font-size:0.75rem;margin:0.6rem 0 0">Computed <span data-age="${at}">${esc(formatAge(at))}</span> by the worker's daily job.</p>`;
}

function drawChart(cmp, ids) {
  const el = document.getElementById('horizon-chart');
  if (!el || !window.Chart) return;
  if (chart) chart.destroy();
  const colours = modelColours();
  const hours = cmp.byHorizon.map((r) => r.hours);
  const label = (h) => (h < 48 ? `${h}h` : `${Math.round(h / 24 * 10) / 10}d`);
  chart = new window.Chart(el, {
    type: 'line',
    data: {
      labels: hours.map(label),
      datasets: ids.map((id) => ({
        label: id,
        data: cmp.byHorizon.map((r) => (r[id] === null || r[id] === undefined ? null : r[id] * 100)),
        borderColor: colours[id], backgroundColor: colours[id],
        borderWidth: id === payload.default ? 2.25 : 1.5, pointRadius: 2, tension: 0.2, spanGaps: false,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: cssVar('--text-2'), boxWidth: 12 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y === null ? '–' : `${c.parsed.y >= 0 ? '+' : ''}${c.parsed.y.toFixed(1)}%`}` } },
      },
      scales: {
        x: { title: { display: true, text: 'How far ahead', color: cssVar('--text-3') }, ticks: { color: cssVar('--text-3'), autoSkip: true, maxRotation: 0 }, grid: { color: cssVar('--line') } },
        y: { title: { display: true, text: 'Skill vs flat price (%)', color: cssVar('--text-3') }, ticks: { color: cssVar('--text-3') }, grid: { color: cssVar('--line') } },
      },
    },
  });
}

function render(d) {
  const ids = d.models.map((m) => m.id);
  const cmp = d.comparison;
  const h2h = cmp.pred10VsPred9;
  const tie = h2h && h2h.lo90 < 0 && h2h.hi90 > 0;
  body.innerHTML = `
    <div class="grid model-grid">${d.models.map(card).join('')}</div>

    <h2 class="section-heading">Head to head</h2>
    <div class="card">
      <p class="dim" style="margin:0 0 0.9rem;max-width:80ch">
        Skill is how much smaller a model's total error was than simply assuming the price stays where
        it is: +10% means 10% less error than that. ${esc(cmp.note)} The best value in each row is
        marked.
      </p>
      ${benchmarks(cmp, ids)}
      ${h2h ? `<p style="margin:0.9rem 0 0;max-width:80ch">pred-10 against pred-9 over all ${formatCompact(cmp.rows)} shared forecasts: ${formatPctSigned(h2h.diff, 2)} of skill
        (90% range ${formatPctSigned(h2h.lo90, 2)} to ${formatPctSigned(h2h.hi90, 2)}, resampled by day over ${h2h.days} days)${tie ? ' – a tie overall; they differ by how far ahead you look and by item, below.' : '.'}</p>` : ''}
    </div>

    <h2 class="section-heading">Skill by how far ahead</h2>
    <div class="card">
      <div class="chart-wrap" style="height:320px"><canvas id="horizon-chart"></canvas></div>
      <p class="dimmer" style="font-size:0.75rem;margin:0.6rem 0 0">pred-7 is only scored up to 5 days. Very short look-aheads score low for every model: over 2 hours a price barely moves, so there is little error to remove.</p>
    </div>

    <h2 class="section-heading">What each model reads</h2>
    <div class="card">${inputsTable(d.inputs, ids)}</div>

    <h2 class="section-heading">Training</h2>
    <div class="card">${trainingTable(d.models)}</div>

    <h2 class="section-heading">Live check</h2>
    <div class="card">${liveSection(d.live, d.liveComputedAt)}</div>`;
  drawChart(cmp, ids);
}

async function load() {
  let res;
  try {
    res = await callWorker('/models');
  } catch (err) {
    renderErrorState(body, 'unreachable');
    return;
  }
  if (res.status !== 200) {
    renderErrorState(body, classifyFailure(null, res.body) || 'unknown');
    return;
  }
  payload = res.body;
  render(payload);
}

window.LucrumTheme.onChange(() => { if (payload) drawChart(payload.comparison, payload.models.map((m) => m.id)); });
load();
