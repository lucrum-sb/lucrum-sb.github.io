// /link page – docs/CONTRACTS.md's account-linking contract. This is the only web-side entry
// point into linking (CLAUDE.md rule 10): it drives `GET /auth/mc-id/start` (the real OAuth
// redirect) and `POST /auth/link/confirm`, and never re-implements the mod's device-code polling
// or any auth logic of its own.
import { WORKER_ORIGIN, callWorker, WorkerUnreachableError } from './api.js';
import { failureText } from './errors.js';
import './shell.js';

const dot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const signinStep = document.getElementById('signin-step');
const signinBtn = document.getElementById('signin-btn');
const signinError = document.getElementById('signin-error');
const codeStep = document.getElementById('code-step');
const codeForm = document.getElementById('code-form');
const codeInput = document.getElementById('code-input');
const codeError = document.getElementById('code-error');
const linkedStep = document.getElementById('linked-step');
const linkedUuid = document.getElementById('linked-uuid');

const params = new URLSearchParams(window.location.search);
const initialCode = (params.get('code') || '').toUpperCase();
codeInput.value = initialCode;

function setStatus(text, tone) {
  statusText.textContent = text;
  dot.classList.remove('is-gain', 'is-loss', 'is-pulsing');
  if (tone === 'gain') dot.classList.add('is-gain');
  if (tone === 'loss') dot.classList.add('is-loss');
  if (tone === 'pending') dot.classList.add('is-pulsing');
}

// The sign-in and code steps are shown together whenever linking isn't finished yet – a player
// may sign in first or paste/retype the code first, and this page doesn't assume an order. Only
// "linked" replaces both.
function showStep(step) {
  signinStep.hidden = step === 'linked';
  codeStep.hidden = step === 'linked';
  linkedStep.hidden = step !== 'linked';
}

/** Declarative, not apologetic – docs/BRAND.md's copy register – and names what actually failed,
 * per CLAUDE.md rule 6, rather than a blank page or a spinner that never resolves. */
function showUnreachable() {
  setStatus('Could not reach the Lucrum worker.', 'loss');
  showStep('signin');
  signinError.hidden = false;
  signinError.textContent = failureText('unreachable');
  signinBtn.disabled = true;
}

async function attemptConfirm(userCode) {
  if (!userCode) {
    setStatus('Enter the code shown by /lucrum link.', null);
    showStep('code');
    return;
  }
  setStatus('Confirming code…', 'pending');
  let result;
  try {
    result = await callWorker('/auth/link/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userCode }),
    });
  } catch (err) {
    if (err instanceof WorkerUnreachableError) return showUnreachable();
    throw err;
  }

  const { status, body } = result;
  if (status === 200 && body.confirmed) {
    setStatus('Linked.', 'gain');
    linkedUuid.textContent = body.uuid;
    showStep('linked');
    return;
  }
  if (body.code === 'NOT_LINKED') {
    setStatus('Sign in to confirm this code.', null);
    showStep('signin');
    return;
  }
  if (body.code === 'DEVICE_CODE_EXPIRED') {
    setStatus('This code has expired.', 'loss');
    showStep('code');
    codeError.hidden = false;
    codeError.textContent = 'Run /lucrum link again in game for a new code.';
    return;
  }
  if (body.code === 'DEVICE_CODE_INVALID') {
    setStatus('That code was not recognised.', 'loss');
    showStep('code');
    codeError.hidden = false;
    codeError.textContent = 'Double-check the code from /lucrum link and try again.';
    return;
  }
  setStatus('Something went wrong confirming the code.', 'loss');
  showStep('code');
  codeError.hidden = false;
  codeError.textContent = body.message || body.code || 'Unknown error.';
}

/** GET /auth/mc-id/start either 302-redirects into the real OAuth flow, or – until Lucas supplies
 * MC-ID OAuth secrets – returns 502 UPSTREAM_UNAVAILABLE (worker/src/api/auth.js). `redirect:
 * 'manual'` lets us tell those two apart without needing CORS: a redirect resolves to an opaque
 * response we can't read but can detect, so we follow it with a real navigation; a same-origin-
 * readable non-redirect response is shown as the declarative error it is. */
signinBtn.addEventListener('click', async () => {
  signinError.hidden = true;
  const code = (codeInput.value || initialCode).trim();
  const url = `${WORKER_ORIGIN}/auth/mc-id/start${code ? `?userCode=${encodeURIComponent(code)}` : ''}`;

  try {
    const res = await fetch(url, { redirect: 'manual', credentials: 'include' });
    if (res.type === 'opaqueredirect' || res.status === 0) {
      window.location.href = url;
      return;
    }
    let message = 'MC-ID sign-in is not available right now.';
    try {
      const body = await res.json();
      message = body.message || message;
    } catch (err) {
      // Body unreadable (most likely CORS, since the worker sends no Access-Control-Allow-Origin
      // header for non-redirect responses) – the fallback message above is still accurate: this
      // codepath only runs for a known-non-redirect (thus non-2xx) response.
    }
    signinError.hidden = false;
    signinError.textContent = message;
  } catch (err) {
    // Network-level failure trying to probe the endpoint – fall back to a plain navigation so the
    // browser's own handling (including the worker's real error page) is still reachable.
    window.location.href = url;
  }
});

codeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  codeError.hidden = true;
  const code = codeInput.value.trim().toUpperCase();
  attemptConfirm(code);
});

attemptConfirm(initialCode);
