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

// The session token. The worker's cookie is a third-party cookie from this site's point of view,
// which Safari blocks, so after sign-in the worker also hands the token over in the URL fragment;
// it is kept here and sent as a bearer header on every call. The fragment is removed from the URL.
const TOKEN_KEY = 'lucrum.token';
{
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const fromRedirect = hash.get('lucrum_token');
  if (fromRedirect) {
    try { localStorage.setItem(TOKEN_KEY, fromRedirect); } catch (err) { /* no persistence available */ }
    window.history.replaceState({}, '', window.location.pathname + window.location.search);
  }
}
function storedToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch (err) { return null; }
}

/** Calls a worker endpoint and returns the parsed JSON body, whatever the status code – the
 * caller branches on `body.code` per docs/CONTRACTS.md, never on the HTTP status alone. Throws
 * WorkerUnreachableError only when the request never got a response at all. */
export async function callWorker(path, init = {}) {
  let res;
  try {
    const token = storedToken();
    const headers = { ...(init.headers || {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
    res = await fetch(`${WORKER_ORIGIN}${path}`, { credentials: 'include', ...init, headers });
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
