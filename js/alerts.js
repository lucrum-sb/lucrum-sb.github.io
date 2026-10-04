// Alerts page – manages the watchlist js/watchlist.js checks on every page. Rules are stored in this
// browser only; nothing here computes a market figure (CLAUDE.md hard rule 2).
import { mountStatusStrip } from './shell.js';
import { esc, itemLabel } from './format.js';
import { FIELDS, getWatchlist, saveWatchlist, addRule, removeRule, describeRule, EVENT_LEAD_MS } from './watchlist.js';
import { parseCoins } from './settings.js';

const slot = document.getElementById('alerts-slot');
const prefill = new URLSearchParams(location.search).get('item');

function permissionText() {
  if (!('Notification' in window)) return 'This browser cannot show notifications – alerts appear as messages on the page instead.';
  if (Notification.permission === 'granted') return 'Browser notifications are on.';
  if (Notification.permission === 'denied') return 'Notifications are blocked for this site – alerts appear as messages on the page instead.';
  return '';
}

function render() {
  const w = getWatchlist();
  const canAsk = 'Notification' in window && Notification.permission === 'default';
  slot.innerHTML = `
    <section class="card" style="margin-bottom:1rem">
      <span class="label">Add a rule</span>
      <form class="trade-form" id="rule-form">
        <label class="filter"><span class="label">Item id</span>
          <input class="input input-sm" name="item" required autocomplete="off" spellcheck="false" value="${esc(prefill || '')}" placeholder="ENCHANTED_DIAMOND" /></label>
        <label class="filter"><span class="label">Figure</span>
          <select class="input input-sm" name="field">${Object.entries(FIELDS).map(([k, f]) => `<option value="${k}">${esc(f.label)}</option>`).join('')}</select></label>
        <label class="filter"><span class="label">When it goes</span>
          <select class="input input-sm" name="op"><option value="below">below</option><option value="above">above</option></select></label>
        <label class="filter"><span class="label">Threshold</span>
          <input class="input input-sm num" name="value" required inputmode="decimal" placeholder="e.g. 1.2k or 5%" /></label>
        <button class="btn btn-primary btn-sm" type="submit">Add</button>
        <p class="error-text" id="rule-error" hidden></p>
      </form>
    </section>

    <section class="card" style="margin-bottom:1rem">
      <label class="filter-check" style="padding:0">
        <input type="checkbox" id="events-toggle"${w.events ? ' checked' : ''} />
        <span>Tell me ${Math.round(EVENT_LEAD_MS / 60000)} minutes before any calendar event opens</span>
      </label>
      <p class="dim" style="font-size:0.82rem;margin:0.6rem 0 0">${esc(permissionText())}
        ${canAsk ? '<button class="btn btn-sm" type="button" id="notify-btn">Allow browser notifications</button>' : ''}</p>
    </section>

    <h2 class="section-heading">Your rules</h2>
    ${w.rules.length ? `<div class="table-wrap"><table class="ledger"><tbody>${w.rules.map((r) => `
      <tr><td class="key"><a href="${document.body.dataset.base}item/?id=${encodeURIComponent(r.item)}">${esc(itemLabel(r.item))}</a>
        <span class="why-line">${esc(describeRule(r))}</span></td>
        <td class="num"><button class="btn btn-sm" type="button" data-remove="${esc(r.id)}">Remove</button></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty-state">No rules yet. Add one above, or use the watch link on any market row.</p>'}
    <p class="dimmer" style="font-size:0.75rem;margin-top:0.8rem">
      Checked only while a Lucrum tab is open, against the worker's own figures. Each rule tells you
      once per crossing and re-arms when the figure moves back.
    </p>`;

  document.getElementById('rule-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const err = document.getElementById('rule-error');
    const item = f.item.value.trim().toUpperCase().replace(/[\s-]+/g, '_');
    const field = f.field.value;
    const raw = f.value.value.trim();
    const value = FIELDS[field].unit === 'fraction'
      ? Number(raw.replace('%', '')) / (raw.endsWith('%') || Number(raw) > 1 ? 100 : 1)
      : parseCoins(raw);
    if (!item || !(Number.isFinite(value))) {
      err.hidden = false;
      err.textContent = 'An item id and a number are both needed (e.g. 1.2k, 5m, or 3% for a margin).';
      return;
    }
    addRule({ item, field, op: f.op.value, value });
    history.replaceState({}, '', location.pathname);
    render();
  });
  document.getElementById('events-toggle').addEventListener('change', (e) => { saveWatchlist({ events: e.target.checked }); });
  const btn = document.getElementById('notify-btn');
  if (btn) btn.addEventListener('click', async () => { try { await Notification.requestPermission(); } catch (err) { /* ok */ } render(); });
  slot.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => { removeRule(b.dataset.remove); render(); }));
}

mountStatusStrip(document.getElementById('status-strip'));
render();
