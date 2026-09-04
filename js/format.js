// Shared number/time formatting – docs/BRAND.md's ledger rule (tabular numerals everywhere money
// appears) and CLAUDE.md rule 12 (local timezone, live). No market logic here (hard rule 3/4):
// this only formats numbers the worker already computed, it never derives or ranks anything.

const coinFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 0 });
const coinFmt2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

/** Coins, thousands-separated, tabular-numeral ready (pair with the `.num` CSS class). */
export function formatCoins(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return coinFmt.format(n);
}

/** Coins with two fixed decimals – for small per-unit margins where the cents matter. */
export function formatCoinsPrecise(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return coinFmt2.format(n);
}

export function formatPct(x, decimals = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return '–';
  return `${(x * 100).toFixed(decimals)}%`;
}

/** holdDays is real days per docs/CONTRACTS.md, may be fractional, already rounded to 2dp. */
export function formatHoldDays(holdDays) {
  if (!holdDays) return '–';
  const { min, max, target } = holdDays;
  return `${min}–${max} days (target ${target})`;
}

export function formatFillMinutes(mins) {
  if (mins === null || mins === undefined) return '–';
  if (mins < 60) return `~${Math.round(mins)}m`;
  return `~${(mins / 60).toFixed(1)}h`;
}

/** Local, live-clock time – never a frozen UTC string. CLAUDE.md rule 12. */
export function formatLocalTime(ts) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Ms duration to a short "2d 4h" / "45m" style string, for a live countdown. Never negative –
 * callers should check for "already open" separately. */
export function formatDuration(ms) {
  if (ms <= 0) return 'now';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** An entry/exit leg from docs/CONTRACTS.md's execution object: method, price, fillProbability,
 * estFillMinutes. Rendered as one short line, price in tabular figures. */
export function formatLeg(leg) {
  if (!leg) return '–';
  const method = leg.method === 'buy_order' || leg.method === 'sell_order' ? 'order' : 'instant';
  return `${formatCoins(leg.price)} (${method}, ${formatPct(leg.fillProbability, 0)} fill, ${formatFillMinutes(leg.estFillMinutes)})`;
}

export function itemLabel(id) {
  if (!id) return '';
  return id
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}
