// Signal browser – docs/CONTRACTS.md's GET /signals, rendered per docs/BRAND.md's "hero is the
// live number" rule. No ranking/scoring logic here (CLAUDE.md hard rule 4): the worker returns
// `score` already sorted-worthy, this page only sorts the array it got and picks the max.
import { callWorker, WorkerUnreachableError } from './api.js';
import { renderErrorState, classifyFailure } from './errors.js';
import {
  formatCoins, formatPct, formatHoldDays, formatLeg, itemLabel,
} from './format.js';

const toggle = document.getElementById('theme-toggle');
function syncToggleLabel() {
  toggle.textContent = window.LucrumTheme.current() === 'dark' ? 'Light mode' : 'Dark mode';
}
syncToggleLabel();
toggle.addEventListener('click', () => { window.LucrumTheme.toggle(); syncToggleLabel(); });

const TYPES = ['position', 'spread', 'craft', 'event'];
const heroSlot = document.getElementById('hero-slot');
const tableSlot = document.getElementById('table-slot');
const tabs = document.querySelectorAll('.type-tab');

let byType = {}; // type -> signals[] sorted by score desc
let activeType = 'position';

function fittedCaveat(signal) {
  // docs/CONTRACTS.md: a `false` fitted flag must be stated in plain words, not just flagged.
  if (signal.fitted === false) {
    return 'This thesis uses a conservative placeholder magnitude, not one measured from stored history.';
  }
  return null;
}

function renderHero() {
  let best = null;
  for (const t of TYPES) {
    for (const s of byType[t] || []) {
      if (!best || s.score > best.score) best = s;
    }
  }
  heroSlot.innerHTML = '';
  if (!best) {
    heroSlot.innerHTML = '<p class="loading-state">No live signals right now.</p>';
    return;
  }
  const el = document.createElement('section');
  el.className = 'hero-signal';
  const caveat = fittedCaveat(best);
  el.innerHTML = `
    <p class="hero-kicker">Top live opportunity &middot; ${best.type}</p>
    <h2>${itemLabel(best.item)}</h2>
    ${best.thesis ? `<p class="thesis">${best.thesis}</p>` : `<p class="thesis">${best.why}</p>`}
    <div class="hero-figures">
      <div class="figure"><span class="label">Score</span><span class="value brass num">${best.score.toFixed(2)}</span></div>
      <div class="figure"><span class="label">Net / unit</span><span class="value num">${formatCoins(best.netPerUnit)}</span></div>
      <div class="figure"><span class="label">Margin</span><span class="value num">${formatPct(best.marginPct)}</span></div>
      ${best.holdDays ? `<div class="figure"><span class="label">Hold</span><span class="value num">${formatHoldDays(best.holdDays)}</span></div>` : ''}
      <div class="figure"><span class="label">Entry</span><span class="value num">${formatCoins(best.entry.price)}</span></div>
      <div class="figure"><span class="label">Exit</span><span class="value num">${formatCoins(best.exit.price)}</span></div>
    </div>
    ${caveat ? `<p class="caveat">${caveat}</p>` : ''}
    <p style="margin-top:1rem"><a href="../item/?id=${encodeURIComponent(best.item)}">View ${itemLabel(best.item)} in detail &rarr;</a></p>
  `;
  heroSlot.appendChild(el);
}

function renderTable() {
  const rows = (byType[activeType] || []).slice().sort((a, b) => b.score - a.score);
  tableSlot.innerHTML = '';
  if (rows.length === 0) {
    tableSlot.innerHTML = `<p class="loading-state">No live ${activeType} signals right now.</p>`;
    return;
  }
  const table = document.createElement('table');
  table.className = 'ledger';
  const showThesis = activeType === 'position' || activeType === 'event';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Item</th>
        <th>Entry</th>
        <th>Exit</th>
        ${showThesis ? '<th>Hold</th>' : ''}
        <th class="num">Net/unit</th>
        <th class="num">Margin</th>
        <th class="num">Score</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');
  for (const s of rows) {
    const tr = document.createElement('tr');
    tr.className = 'signal-row';
    const caveat = fittedCaveat(s);
    tr.innerHTML = `
      <td class="item"><a href="../item/?id=${encodeURIComponent(s.item)}">${itemLabel(s.item)}</a>
        <span class="why">${showThesis ? (s.thesis || s.why) : s.why}${caveat ? ` ${caveat}` : ''}</span>
      </td>
      <td data-label="Entry" class="num">${formatLeg(s.entry)}</td>
      <td data-label="Exit" class="num">${formatLeg(s.exit)}</td>
      ${showThesis ? `<td data-label="Hold" class="num">${formatHoldDays(s.holdDays)}</td>` : ''}
      <td data-label="Net/unit" class="num">${formatCoins(s.netPerUnit)}</td>
      <td data-label="Margin" class="num">${formatPct(s.marginPct)}</td>
      <td data-label="Score" class="num">${s.score.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  }
  tableSlot.appendChild(table);
}

tabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    activeType = btn.dataset.type;
    tabs.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    renderTable();
  });
});

async function loadType(type) {
  try {
    const { status, body } = await callWorker(`/signals?type=${type}&limit=25`);
    if (status === 200) {
      byType[type] = body.signals || [];
    } else {
      byType[type] = [];
    }
  } catch (err) {
    if (err instanceof WorkerUnreachableError) throw err;
    byType[type] = [];
  }
}

(async function init() {
  try {
    await Promise.all(TYPES.map(loadType));
  } catch (err) {
    renderErrorState(heroSlot, classifyFailure(err) || 'unreachable');
    renderErrorState(tableSlot, classifyFailure(err) || 'unreachable');
    return;
  }
  renderHero();
  renderTable();
})();
