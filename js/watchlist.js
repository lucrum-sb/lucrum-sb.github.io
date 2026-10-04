// Watchlist alerts – docs/PLAN.md Phase 9's "notify when a watchlist item crosses a threshold or an
// event window opens", for the web, while any Lucrum tab is open.
//
// Rules live in localStorage (a per-viewer convenience: guarded, optional, and never read by the
// worker). Every minute, if there is at least one rule, the open tab fetches GET /market and
// GET /calendar and compares the worker's own figures against the viewer's thresholds. Comparing a
// number to a threshold the viewer typed is not market arithmetic (CLAUDE.md hard rule 2) – every
// figure checked here was computed by the worker.
//
// Delivered as a browser notification when the viewer allowed them, and always as an in-page toast.
// Each rule fires once per crossing: it re-arms only after the condition has been false again, so
// a price sitting under its threshold does not notify every minute. Alerts that reach a phone with
// every tab closed need the worker to send them, which needs a signed-in account – a follow-up for
// when MC-ID sign-in is live.
import { callWorker } from './api.js';

const RULES_KEY = 'lucrum-watchlist';
const STATE_KEY = 'lucrum-watchlist-state';
const LEADER_KEY = 'lucrum-watchlist-leader';
const CHECK_MS = 60_000;
/** How far ahead an event alert fires. */
export const EVENT_LEAD_MS = 10 * 60_000;

/** Figures a rule can watch – all GET /market fields. */
export const FIELDS = {
  buyOrderPrice: { label: 'Buy order price', unit: 'coins' },
  sellOfferPrice: { label: 'Sell offer price', unit: 'coins' },
  riskAdjustedNetPerSlotHour: { label: 'Net / slot-hour', unit: 'coins' },
  marginPct: { label: 'Margin', unit: 'fraction' },
  npcMarginPct: { label: 'NPC margin', unit: 'fraction' },
  instantSellsPerHour: { label: 'Sold / hour', unit: 'units' },
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* storage unavailable */ }
}

/** { rules: [{id, item, field, op: 'below'|'above', value}], events: boolean } */
export function getWatchlist() {
  const w = read(RULES_KEY, {});
  return { rules: Array.isArray(w.rules) ? w.rules : [], events: !!w.events };
}

export function saveWatchlist(next) {
  write(RULES_KEY, { ...getWatchlist(), ...next });
}

export function addRule(rule) {
  const w = getWatchlist();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  saveWatchlist({ rules: [...w.rules, { ...rule, id }] });
  return id;
}

export function removeRule(id) {
  const w = getWatchlist();
  saveWatchlist({ rules: w.rules.filter((r) => r.id !== id) });
}

export function describeRule(r) {
  const f = FIELDS[r.field];
  const v = f && f.unit === 'fraction' ? `${(r.value * 100).toFixed(1)}%` : Number(r.value).toLocaleString();
  return `${r.item} ${f ? f.label.toLowerCase() : r.field} ${r.op} ${v}`;
}

function toast(text) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  host.appendChild(el);
  setTimeout(() => el.remove(), 12_000);
}

function notify(title, body) {
  toast(`${title} – ${body}`);
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, tag: title });
  } catch (err) { /* the toast already said it */ }
}

/** Only one open tab checks at a time, so three tabs do not notify three times. */
function claimLeadership() {
  const now = Date.now();
  const lead = read(LEADER_KEY, null);
  if (lead && lead.until > now && lead.tab !== TAB_ID) return false;
  write(LEADER_KEY, { tab: TAB_ID, until: now + CHECK_MS * 1.5 });
  return true;
}

const TAB_ID = Math.random().toString(36).slice(2);

async function check() {
  const w = getWatchlist();
  if (w.rules.length === 0 && !w.events) return;
  if (!claimLeadership()) return;
  const state = read(STATE_KEY, { fired: {}, events: {} });

  if (w.rules.length > 0) {
    try {
      const { status, body } = await callWorker('/market');
      if (status === 200) {
        for (const r of w.rules) {
          const row = body.items && body.items[r.item];
          const v = row ? row[r.field] : null;
          if (v === null || v === undefined || !Number.isFinite(v)) continue;
          const hit = r.op === 'below' ? v < r.value : v > r.value;
          if (hit && !state.fired[r.id]) notify('Lucrum watchlist', `${describeRule(r)} (now ${Number(v).toLocaleString()})`);
          state.fired[r.id] = hit;
        }
      }
    } catch (err) { /* the worker is unreachable; the status strip already says so */ }
  }

  if (w.events) {
    const now = Date.now();
    try {
      const { status, body } = await callWorker(`/calendar?from=${now}&to=${now + EVENT_LEAD_MS}`);
      if (status === 200) {
        for (const ev of body.events || []) {
          const key = `${ev.id}:${ev.start}`;
          if (ev.start > now && ev.start - now <= EVENT_LEAD_MS && !state.events[key]) {
            notify('Lucrum calendar', `${ev.label} opens in ${Math.max(1, Math.round((ev.start - now) / 60_000))} min`);
            state.events[key] = true;
          }
        }
        // Forget events that have passed, so the state does not grow forever.
        for (const key of Object.keys(state.events)) if (Number(key.split(':').pop()) < now - 86_400_000) delete state.events[key];
      }
    } catch (err) { /* as above */ }
  }
  write(STATE_KEY, state);
}

let started = false;
/** Called once per page by js/shell.js. Costs nothing when the watchlist is empty. */
export function startWatchlist() {
  if (started) return;
  started = true;
  setTimeout(check, 5_000);
  const timer = setInterval(check, CHECK_MS);
  window.addEventListener('pagehide', () => clearInterval(timer));
}
