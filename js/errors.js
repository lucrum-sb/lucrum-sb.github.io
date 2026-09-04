// Shared "degrade honestly" state rendering – docs/BRAND.md's copy register (declarative, never
// apologetic) and CLAUDE.md rule 6 (name what failed, never a blank page or an infinite spinner).
import { WORKER_ORIGIN, WorkerUnreachableError } from './api.js';

/** Renders a named error state into `el`. `kind` picks the copy; everything else is context. */
export function renderErrorState(el, kind, extra = {}) {
  const { item, uuid } = extra;
  const copy = {
    unreachable: `The worker at ${WORKER_ORIGIN} did not respond. Check your connection and reload.`,
    insufficient_history: `Not enough stored history for ${item || 'this item'} over this range yet.`,
    item_not_found: `No such item: ${item || 'unknown'}.`,
    range_invalid: 'That range is not one of the ones this page supports.',
    rate_limited: 'The worker is rate-limiting this page. Wait a moment and reload.',
    portfolio_private: 'This portfolio is private. Its owner has not made it public.',
    profile_not_found: `No profile found for ${uuid || 'that account'}.`,
    not_linked: 'Sign in with MC-ID to view this.',
    internal: 'The worker hit an internal error processing this request.',
    unknown: 'Something went wrong loading this page.',
  }[kind] || 'Something went wrong loading this page.';

  el.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'error-state';
  p.textContent = copy;
  el.appendChild(p);
}

/** Maps a callWorker() result (or a thrown WorkerUnreachableError) to one of renderErrorState's
 * known kinds, so every page branches on the same small vocabulary. */
export function classifyFailure(err, body) {
  if (err instanceof WorkerUnreachableError) return 'unreachable';
  const code = body && body.code;
  switch (code) {
    case 'INSUFFICIENT_HISTORY':
      return 'insufficient_history';
    case 'ITEM_NOT_FOUND':
      return 'item_not_found';
    case 'RANGE_INVALID':
      return 'range_invalid';
    case 'RATE_LIMITED':
      return 'rate_limited';
    case 'PORTFOLIO_PRIVATE':
      return 'portfolio_private';
    case 'NOT_LINKED':
      return 'not_linked';
    case 'INTERNAL':
      return 'internal';
    default:
      return body && body.error ? 'unknown' : null;
  }
}
