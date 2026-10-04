// Shared number/time formatting – docs/BRAND.md's type rule (every number is mono with tabular
// figures; pair each of these with the `.num` class) and CLAUDE.md rule 12 (local timezone, live).
// No market logic here (hard rule 3/4): this only formats numbers the worker already computed, it
// never derives or ranks anything.

const coinFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 0 });
const coinFmt2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const MISSING = '–';

function absent(n) {
  return n === null || n === undefined || Number.isNaN(n);
}

/** Coins, thousands-separated. */
export function formatCoins(n) {
  if (absent(n)) return MISSING;
  return coinFmt.format(n);
}

/** Coins with two fixed decimals – for small per-unit margins where the fractions matter. */
export function formatCoinsPrecise(n) {
  if (absent(n)) return MISSING;
  return coinFmt2.format(n);
}

/** Whole units – quantities, order counts, row counts. */
export function formatInt(n) {
  if (absent(n)) return MISSING;
  return intFmt.format(n);
}

/** Compact magnitude for volume columns, where 4,183,209 costs more width than it earns. Keeps
 * one decimal below 100 so 1.4M and 14M stay distinguishable at a glance. */
export function formatCompact(n) {
  if (absent(n)) return MISSING;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(abs / 1e9 >= 100 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(abs / 1e6 >= 100 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(abs / 1e3 >= 100 ? 0 : 1)}k`;
  return intFmt.format(n);
}

export function formatPct(x, decimals = 1) {
  if (absent(x)) return MISSING;
  return `${(x * 100).toFixed(decimals)}%`;
}

/** A percentage that carries a sign, for anything that can go either way. */
export function formatPctSigned(x, decimals = 1) {
  if (absent(x)) return MISSING;
  const s = (x * 100).toFixed(decimals);
  return `${x > 0 ? '+' : ''}${s}%`;
}

/** `pos`/`neg`/`` for colouring a figure by its sign. Zero is neutral, not green. */
export function signClass(n) {
  if (absent(n) || n === 0) return '';
  return n > 0 ? 'pos' : 'neg';
}

/** holdDays is real days per docs/CONTRACTS.md, may be fractional. Sub-day holds are shown in
 * hours – "0.02–0.05 days" is a number the reader has to convert themselves. */
export function formatHoldDays(holdDays) {
  if (!holdDays) return MISSING;
  const { min, max, target } = holdDays;
  if (max < 1) {
    return `${(min * 24).toFixed(1)}–${(max * 24).toFixed(1)}h`;
  }
  return `${min}–${max}d (${target}d)`;
}

export function formatFillMinutes(mins) {
  if (absent(mins)) return MISSING;
  if (mins <= 0) return 'instant';
  if (mins < 60) return `~${Math.round(mins)}m`;
  if (mins < 1440) return `~${(mins / 60).toFixed(1)}h`;
  return `~${(mins / 1440).toFixed(1)}d`;
}

/** Local, live-clock time – never a frozen UTC string. CLAUDE.md rule 12. */
export function formatLocalTime(ts) {
  if (absent(ts) || ts === 0) return MISSING;
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatLocalShort(ts) {
  if (absent(ts) || ts === 0) return MISSING;
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Ms duration to a short "2d 4h" / "45m" / "12s" string, for a live countdown. Never negative –
 * callers check for "already open" separately. */
export function formatDuration(ms) {
  if (ms <= 0) return 'now';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

/** "4m ago" / "in 2h" relative to now, for freshness readouts that tick. */
export function formatAge(ts, now = Date.now()) {
  if (absent(ts) || ts === 0) return MISSING;
  const delta = now - ts;
  if (delta < 0) return `in ${formatDuration(-delta)}`;
  if (delta < 5000) return 'just now';
  return `${formatDuration(delta)} ago`;
}

const METHOD_LABEL = {
  instant_buy: 'instant',
  instant_sell: 'instant',
  buy_order: 'order',
  sell_order: 'order',
  npc_sell: 'sell to NPC',
};

export function methodLabel(method) {
  return METHOD_LABEL[method] || method || MISSING;
}

/** An entry/exit leg from docs/CONTRACTS.md's execution object, as one short line. The fill
 * probability and estimated fill time are what make a patient order different from an instant
 * one, so neither is dropped. */
export function formatLeg(leg) {
  if (!leg) return MISSING;
  return `${formatCoins(leg.price)} · ${methodLabel(leg.method)} · ${formatPct(leg.fillProbability, 0)} · ${formatFillMinutes(leg.estFillMinutes)}`;
}

/** SCREAMING_SNAKE product id to a readable label. The raw id stays visible next to it wherever
 * this is used – it is what the reader types into the bazaar search box. */
export function itemLabel(id) {
  if (!id) return '';
  return id
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

/** Escapes a value before it goes into an innerHTML template. Item ids and worker-authored
 * strings are trusted-ish, but nothing here is worth an injection bug. */
export function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
