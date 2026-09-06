// Shared "degrade honestly" state rendering – docs/BRAND.md's copy register (declarative, never
// apologetic) and CLAUDE.md rule 6 (name what failed, never a blank page or an infinite spinner).
// Every code in docs/CONTRACTS.md's error list has copy here, including UPSTREAM_UNAVAILABLE,
// which is a real live state whenever a scoring pass hasn't completed yet.
import { WORKER_ORIGIN, WorkerUnreachableError } from './api.js';

const COPY = {
  unreachable: () => `The worker at ${WORKER_ORIGIN} did not respond. Check your connection and reload.`,
  upstream_unavailable: ({ what }) => (
    `${what || 'This data'} is not available yet. The worker has no completed pass to serve – it is computed on a schedule, not on request, so this resolves on its own within a few minutes.`
  ),
  // "Try a shorter range" was wrong advice: /history now returns whatever part of a window it has,
  // so this code means there is genuinely no bar at that range's resolution. For 1d that is a
  // storage decision rather than a young item – bars_5m is written only for the busiest products –
  // and pointing at a shorter range would send the reader to 1h, which is thinner still.
  insufficient_history: ({ item, range }) => (range === '1d'
    ? `No five-minute bars are stored for ${item || 'this item'}. That tier is kept only for the 100 highest-volume products; the other ranges read the hourly tier, which covers everything.`
    : `No stored history for ${item || 'this item'} at this range's resolution yet.`),
  no_realised_data: ({ item }) => (
    `Nothing was recorded for ${item || 'this item'} over the scored window, so there is nothing to compare the model against.`
  ),
  item_not_found: ({ item }) => `No bazaar product with the id ${item || '(none given)'}.`,
  range_invalid: () => 'That range is not one this page supports.',
  rate_limited: () => 'The worker is rate-limiting this page. Wait a moment and reload.',
  portfolio_private: () => 'This portfolio is private. Its owner has not made it public.',
  profile_not_found: ({ uuid }) => `No profile found for ${uuid || 'that account'}.`,
  not_linked: () => 'Sign in with MC-ID to view this.',
  device_code_expired: () => 'That link code has expired. Run /lucrum link again in game.',
  device_code_invalid: () => 'That link code was not recognised.',
  internal: () => 'The worker hit an internal error processing this request.',
  unknown: () => 'Something went wrong loading this.',
};

/** Renders a named error state into `el`, replacing whatever was there. `kind` picks the copy;
 * everything else is context (`item`, `uuid`, `what`). */
export function renderErrorState(el, kind, extra = {}) {
  const fn = COPY[kind] || COPY.unknown;
  el.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'error-state';
  p.textContent = fn(extra);
  el.appendChild(p);
}

/** Maps a callWorker() result (or a thrown WorkerUnreachableError) to one of renderErrorState's
 * kinds, so every page branches on the same small vocabulary. Returns null when the body is a
 * successful response, so callers can tell "no failure" from "unknown failure". */
export function classifyFailure(err, body) {
  if (err instanceof WorkerUnreachableError) return 'unreachable';
  const code = body && body.code;
  switch (code) {
    case 'UPSTREAM_UNAVAILABLE': return 'upstream_unavailable';
    case 'INSUFFICIENT_HISTORY': return 'insufficient_history';
    case 'NO_REALISED_DATA': return 'no_realised_data';
    case 'ITEM_NOT_FOUND': return 'item_not_found';
    case 'RANGE_INVALID': return 'range_invalid';
    case 'RATE_LIMITED': return 'rate_limited';
    case 'PORTFOLIO_PRIVATE': return 'portfolio_private';
    case 'PROFILE_NOT_FOUND': return 'profile_not_found';
    case 'NOT_LINKED': return 'not_linked';
    case 'DEVICE_CODE_EXPIRED': return 'device_code_expired';
    case 'DEVICE_CODE_INVALID': return 'device_code_invalid';
    case 'INTERNAL': return 'internal';
    default:
      return body && body.error ? 'unknown' : null;
  }
}

/** The same copy as a plain string, for inline slots too small for a panel. */
export function failureText(kind, extra = {}) {
  return (COPY[kind] || COPY.unknown)(extra);
}
