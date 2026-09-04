// Shared portfolio rendering – used by both the public profile page (/p/) and the owner's
// account page (/account/), so the two never drift into different presentations of the same
// data. Renders `planned` and `actual` as distinct columns per CLAUDE.md rule 13 – never
// collapsed into one number. Realised P&L and hit rate always come from `actual`/`stats`
// (worker-computed from actual only, per docs/CONTRACTS.md), never substituted from `planned`.
import { formatCoins, itemLabel, formatLocalTime, formatPct } from './format.js';

const TYPES = ['position', 'spread', 'craft', 'event'];

function plannedActualCell(planned, actualObj, key, isPrice = true) {
  const p = planned ? planned[key] : null;
  const a = actualObj ? actualObj[key] : null;
  const fmt = (v) => (isPrice ? formatCoins(v) : v);
  return `
    <span class="planned-actual">
      ${p !== null && p !== undefined ? `<span class="planned">planned ${fmt(p)}</span>` : '<span class="planned">no plan</span>'}
      <span class="actual">${a !== null && a !== undefined ? fmt(a) : 'unconfirmed'}</span>
    </span>
  `;
}

function positionRow(pos, open) {
  const netKey = 'netPnl';
  return `
    <tr>
      <td class="item">${itemLabel(pos.item)}<span class="why">${pos.type} &middot; qty ${pos.qty}</span></td>
      <td data-label="Opened">${formatLocalTime(pos.openedAt)}</td>
      ${open ? '' : `<td data-label="Closed">${pos.closedAt ? formatLocalTime(pos.closedAt) : '–'}</td>`}
      <td data-label="Entry" class="num">${plannedActualCell(pos.planned, pos.actual, 'entryPrice')}</td>
      ${open ? '' : `<td data-label="Exit" class="num">${plannedActualCell(pos.planned, pos.actual, 'exitPrice')}</td>`}
      ${open ? '' : `<td data-label="Net P&amp;L" class="num">${plannedActualCell(pos.planned, pos.actual, netKey)}</td>`}
    </tr>
  `;
}

/** Renders a full profile view into `container`. `data` is GET /portfolio/<uuid>'s body. */
export function renderProfile(container, data) {
  const { ign, uuid, public: isPublic, stats, open = [], closed = [] } = data;

  const hitRateCells = TYPES.map((t) => {
    const v = stats.hitRateByType ? stats.hitRateByType[t] : null;
    return `<div class="cell"><span class="label">${t}</span><span class="value num">${v === null || v === undefined ? '–' : formatPct(v)}</span></div>`;
  }).join('');

  container.innerHTML = `
    <div class="profile-head">
      <h2>${ign || itemLabel(uuid)}</h2>
      <p style="color:var(--text-dim)" class="num">${uuid}${isPublic === false ? ' &middot; private profile' : ''}</p>
    </div>

    <div class="stat-grid">
      <div class="stat-card">
        <span class="label">Realised P&amp;L (actual)</span>
        <span class="value num">${formatCoins(stats.realizedPnl)}</span>
      </div>
      <div class="stat-card">
        <span class="label">Open positions</span>
        <span class="value num">${stats.openPositions}</span>
      </div>
      <div class="stat-card">
        <span class="label">Closed positions</span>
        <span class="value num">${stats.closedPositions}</span>
      </div>
      <div class="stat-card" style="grid-column: 1 / -1">
        <span class="label">Hit rate by type (actual)</span>
        <div class="hitrate-grid">${hitRateCells}</div>
      </div>
    </div>

    <h3 class="section-heading">Open positions</h3>
    ${open.length ? `
      <table class="ledger">
        <thead><tr><th>Item</th><th>Opened</th><th class="num">Entry</th></tr></thead>
        <tbody>${open.map((p) => positionRow(p, true)).join('')}</tbody>
      </table>
    ` : '<p class="loading-state">No open positions.</p>'}

    <h3 class="section-heading">Closed positions</h3>
    ${closed.length ? `
      <table class="ledger">
        <thead><tr><th>Item</th><th>Opened</th><th>Closed</th><th class="num">Entry</th><th class="num">Exit</th><th class="num">Net P&amp;L</th></tr></thead>
        <tbody>${closed.map((p) => positionRow(p, false)).join('')}</tbody>
      </table>
    ` : '<p class="loading-state">No closed positions.</p>'}
  `;
}
