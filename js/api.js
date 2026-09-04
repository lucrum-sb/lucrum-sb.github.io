// Thin fetch wrapper against the worker – docs/CONTRACTS.md's error shape and account-linking
// section. No market logic lives here (CLAUDE.md rule 2/hard rule 3): this module only calls
// endpoints and normalises transport failures, it never computes anything itself.
//
// WORKER_ORIGIN: confirmed live at deploy time (mod/CHECKLIST.md). Override for local dev with
// `window.LUCRUM_WORKER_ORIGIN = 'http://127.0.0.1:8787'` set before this module loads.
export const WORKER_ORIGIN = window.LUCRUM_WORKER_ORIGIN || 'https://lucrum.lancus.workers.dev';

/** A worker call that could not complete at all – network down, CORS blocked, DNS failure. Kept
 * distinct from a well-formed { error: true, code } response, since the caller needs to say
 * "the worker is unreachable" rather than naming a code that was never actually returned. */
export class WorkerUnreachableError extends Error {
  constructor(cause) {
    super('Could not reach the Lucrum worker.');
    this.cause = cause;
  }
}

/** Calls a worker endpoint and returns the parsed JSON body, whatever the status code – the
 * caller branches on `body.code` per docs/CONTRACTS.md, never on the HTTP status alone. Throws
 * WorkerUnreachableError only when the request never got a response at all. */
export async function callWorker(path, init = {}) {
  let res;
  try {
    res = await fetch(`${WORKER_ORIGIN}${path}`, { credentials: 'include', ...init });
  } catch (err) {
    throw new WorkerUnreachableError(err);
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new WorkerUnreachableError(err);
  }
  return { status: res.status, body };
}
