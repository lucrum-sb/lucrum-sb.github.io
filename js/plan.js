// Plan – GET /plan. Shows which orders to place now for the viewer's own capital, order slots and
// hands-on time. Every figure is the worker's (quant/plan.js); this page only renders the plan and
// re-requests it when the viewer's settings change (CLAUDE.md hard rule 2).
import { callWorker, WorkerUnreachableError } from './api.js';
import { renderErrorState, classifyFailure } from './errors.js';
import { mountStatusStrip, itemHref } from './shell.js';
import {
  formatCoins, formatCompact, formatInt, formatHoldDays, formatFillMinutes, methodLabel, itemLabel, esc,
} from './format.js';
import { getSettings, mountSettingsBar, onSettingsChange } from './settings.js';

const slot = document.getElementById('plan-slot');

const BINDING_TEXT = {
  slots: 'Every order slot is in use – a higher Bazaar Flipper level would add 7 more.',
  capital: 'Your capital is fully deployed.',
  time: 'Your hands-on budget is used up – allow more minutes an hour to fit more NPC and craft trades.',
  'daily-cap': 'The plan is paced to the bazaar\'s ~15B daily order cap over 8 hours of trading – every order you place, and every relist, counts toward it even if it never fills.',
  opportunities: 'Nothing else currently clears the worker\'s scoring with what you have left.',
};

function leg(l) {
  if (!l) return '–';
  return `${formatCoins(l.price)}<span class="why-line">${esc(methodLabel(l.method))}${l.estFillMinutes ? ` · ${esc(formatFillMinutes(l.estFillMinutes))}` : ''}</span>`;
}

function render(plan) {
  if (!plan.picks.length) {
    slot.innerHTML = `<p class="empty-state">No trade fits these limits right now. ${esc(BINDING_TEXT[plan.binding] || '')}</p>`;
    return;
  }
  const totals = `
    <div class="card plan-totals">
      <div class="hero-figures">
        <div class="stat"><span class="label">Planned net / hour</span><span class="value lg accent">${formatCompact(plan.netPerHour)}</span><p class="note">if every order fills as estimated</p></div>
        <div class="stat"><span class="label">Order slots</span><span class="value lg">${formatInt(plan.used.slots)} / ${formatInt(plan.slots)}</span></div>
        <div class="stat"><span class="label">Capital used</span><span class="value lg">${formatCompact(plan.used.capital)}</span><p class="note">of ${formatCompact(plan.capitalCoins)}</p></div>
        <div class="stat"><span class="label">Daily order cap</span><span class="value lg">${plan.dailyCapHours === null || plan.dailyCapHours === undefined ? '–' : `${plan.dailyCapHours}h`}</span><p class="note">how long ~15B of orders lasts at this pace</p></div>
        <div class="stat"><span class="label">Hands-on</span><span class="value lg">${plan.activeMinutesPerHour} min</span><p class="note">per hour, of ${plan.maxActiveMinutesPerHour} min allowed</p></div>
      </div>
      <p class="dim" style="margin:0.8rem 0 0;font-size:0.82rem">${esc(BINDING_TEXT[plan.binding] || '')}</p>
    </div>`;

  const rows = plan.picks.map((p) => `
    <tr>
      <td class="key"><a href="${itemHref(p.item)}">${esc(itemLabel(p.item))}</a>
        <span class="why-line"><span class="type-badge">${esc(p.type)}</span> ${esc(p.why || '')}</span></td>
      <td class="num">${formatInt(p.qty)}<span class="why-line">${formatInt(p.orders)} order${p.orders === 1 ? '' : 's'} · ${formatInt(p.slots)} slot${p.slots === 1 ? '' : 's'}</span></td>
      <td class="num buy-c">${leg(p.entry)}</td>
      <td class="num sell-c">${leg(p.exit)}</td>
      <td class="num">${formatCompact(p.capital)}</td>
      <td class="num strong">${formatCompact(p.net)}</td>
      <td class="num">${p.holdDays ? esc(formatHoldDays(p.holdDays)) : `${p.cycleHours}h`}</td>
      <td class="num">${formatCompact(p.netPerHour)}</td>
      <td class="num">${p.reliability.toFixed(2)}</td>
    </tr>`).join('');

  slot.innerHTML = `
    ${totals}
    <div class="table-wrap"><div class="table-scroll">
      <table class="ledger"><thead><tr>
        <th>Item</th><th class="num">Qty</th><th class="num">Entry</th><th class="num">Exit</th>
        <th class="num">Capital</th><th class="num">Net</th><th class="num" title="Entry fill + hold + exit fill">Cycle</th>
        <th class="num">Net / hour</th>
        <th class="num" title="How likely the planned coins are to arrive: fill odds, liquidity, manipulation risk, margin plausibility and, for theses, conviction.">Reliability</th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div></div>
    <p class="dimmer" style="font-size:0.75rem;margin-top:0.6rem">
      A greedy packing of the worker's current signals, rebuilt every 30 seconds – a starting plan,
      not an optimum. Exit prices on position trades are targets, not quotes. Advisory only: Lucrum
      never places an order for you.
    </p>`;
}

async function load() {
  const { capital, flipper, active } = getSettings();
  if (!(capital > 0)) {
    slot.innerHTML = '<p class="empty-state">Enter your capital above to build a plan.</p>';
    return;
  }
  slot.innerHTML = '<p class="loading-state">Packing your order slots&hellip;</p>';
  try {
    const { status, body } = await callWorker(`/plan?capital=${capital}&flipper=${flipper}&active=${active}`);
    if (status !== 200) {
      renderErrorState(slot, classifyFailure(null, body) || 'unknown', { what: 'The planner' });
      return;
    }
    render(body);
  } catch (err) {
    renderErrorState(slot, err instanceof WorkerUnreachableError ? 'unreachable' : 'unknown', { what: 'The planner' });
  }
}

mountStatusStrip(document.getElementById('status-strip'));
mountSettingsBar(document.getElementById('settings-bar'), { showActive: true });
onSettingsChange(load);
load();
