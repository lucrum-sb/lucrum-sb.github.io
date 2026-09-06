// Shared portfolio rendering – used by both the public profile page (/p/) and the owner's account
// page (/account/), so the two never drift into different presentations of the same data.
//
// CLAUDE.md rule 13, which this file exists to enforce visually: `planned` and `actual` are always
// rendered as separate values, never collapsed into one number and never substituted for each
// other. Realised P&L and hit rate come from `stats` (worker-computed from actuals only) – a plan
// is never called realised.
import { itemHref } from './shell.js';
import {
  formatCoins, formatCoinsPrecise, formatInt, formatPct, formatLocalTime, formatDuration,
  itemLabel, esc, signClass,
} from './format.js';

const TYPES = ['position', 'spread', 'craft', 'event'];

function plannedActual(planned, actual, key, fmt = formatCoins) {
  const p = planned ? planned[key] : null;
  const a = actual ? actual[key] : null;
  const has = (v) => v !== null && v !== undefined;
  return `
    <span class="planned-actual">
      <span class="planned">${has(p) ? `planned ${fmt(p)}` : 'no plan'}</span>
      <span class="actual${has(a) ? '' : ' unconfirmed'}">${has(a) ? fmt(a) : 'unconfirmed'}</span>
    </span>`;
}

function positionRow(pos, open, now) {
  const held = open ? now - pos.openedAt : (pos.closedAt || now) - pos.openedAt;
  const net = pos.actual ? pos.actual.netPnl : null;
  return `
    <tr>
      <td class="key"><a href="${itemHref(pos.item)}">${esc(itemLabel(pos.item))}</a>
        <span class="why-line">${esc(pos.type)} · ${formatInt(pos.qty)} units</span></td>
      <td class="num">${esc(formatLocalTime(pos.openedAt))}
        <span class="why-line" data-held="${pos.openedAt}"${open ? '' : ' data-static="1"'}>held ${esc(formatDuration(held))}</span></td>
      ${open ? '' : `<td class="num">${pos.closedAt ? esc(formatLocalTime(pos.closedAt)) : '–'}</td>`}
      <td class="num">${plannedActual(pos.planned, pos.actual, 'entryPrice')}</td>
      ${open ? '' : `<td class="num">${plannedActual(pos.planned, pos.actual, 'exitPrice')}</td>`}
      ${open ? '' : `<td class="num ${signClass(net)}">${plannedActual(pos.planned, pos.actual, 'netPnl', formatCoinsPrecise)}</td>`}
    </tr>`;
}

/** Renders a full profile view into `container`. `data` is GET /portfolio/<uuid>'s body. */
export function renderProfile(container, data) {
  const { ign, uuid, public: isPublic, stats = {}, open = [], closed = [] } = data;
  const now = Date.now();

  const hitRate = TYPES.map((t) => {
    const v = stats.hitRateByType ? stats.hitRateByType[t] : null;
    return `<div class="stat"><span class="label">${t}</span>
      <span class="value">${v === null || v === undefined ? '–' : formatPct(v)}</span></div>`;
  }).join('');

  container.innerHTML = `
    <div class="profile-head">
      <h1>${esc(ign || 'Portfolio')}</h1>
      <span class="uuid">${esc(uuid)}${isPublic === false ? ' · private' : ''}</span>
    </div>

    <div class="grid grid-3">
      <div class="stat card card-tight"><span class="label">Realised P&amp;L (actual)</span>
        <span class="value lg ${signClass(stats.realizedPnl)}">${formatCoins(stats.realizedPnl)}</span>
        <p class="note">confirmed fills only</p></div>
      <div class="stat card card-tight"><span class="label">Open positions</span>
        <span class="value lg">${formatInt(stats.openPositions)}</span></div>
      <div class="stat card card-tight"><span class="label">Closed positions</span>
        <span class="value lg">${formatInt(stats.closedPositions)}</span></div>
    </div>

    <div class="card" style="margin-top:0.75rem">
      <span class="label">Hit rate by type (actual)</span>
      <div class="grid grid-4" style="margin-top:0.5rem">${hitRate}</div>
    </div>

    <h2 class="section-heading">Open positions</h2>
    ${open.length ? `
      <div class="table-wrap"><div class="table-scroll"><table class="ledger">
        <thead><tr><th>Item</th><th class="num">Opened</th><th class="num">Entry</th></tr></thead>
        <tbody>${open.map((p) => positionRow(p, true, now)).join('')}</tbody>
      </table></div></div>` : '<p class="empty-state">No open positions.</p>'}

    <h2 class="section-heading">Closed positions</h2>
    ${closed.length ? `
      <div class="table-wrap"><div class="table-scroll"><table class="ledger">
        <thead><tr><th>Item</th><th class="num">Opened</th><th class="num">Closed</th>
          <th class="num">Entry</th><th class="num">Exit</th><th class="num">Net P&amp;L</th></tr></thead>
        <tbody>${closed.map((p) => positionRow(p, false, now)).join('')}</tbody>
      </table></div></div>` : '<p class="empty-state">No closed positions.</p>'}

    <p class="dimmer" style="font-size:0.75rem;margin-top:1rem">
      Planned is what a signal proposed. Actual is a confirmed fill, parsed from bazaar chat or
      entered by hand. Realised P&amp;L and hit rate are computed from actuals only.
    </p>`;

  startHeldTicker(container);
}

/** An open position's holding time counts up live – CLAUDE.md rule 12. Closed positions carry a
 * fixed duration and are left alone. */
function startHeldTicker(container) {
  if (container._heldTimer) clearInterval(container._heldTimer);
  const tick = () => {
    const now = Date.now();
    container.querySelectorAll('[data-held]:not([data-static])').forEach((el) => {
      el.textContent = `held ${formatDuration(now - Number(el.dataset.held))}`;
    });
  };
  container._heldTimer = setInterval(tick, 1000);
  window.addEventListener('pagehide', () => clearInterval(container._heldTimer));
}
