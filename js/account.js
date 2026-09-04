// Account page – the direct MC-ID login entry point per docs/PLAN.md's Phase 8 brief: this is a
// *second* real use of GET /auth/mc-id/start beyond what /link/'s device-code confirmation
// already built (docs/CONTRACTS.md's account-linking section), reusing the same session cookie
// and sign-in pattern js/link.js established – not a parallel auth flow.
//
// Assumption, documented since docs/CONTRACTS.md doesn't specify it: GET /auth/mc-id/callback
// redirects the browser back to a `returnTo` URL after setting `lucrum_session`, and includes the
// signed-in player's `uuid` (and `ign`) as query params on that redirect – this is the only way a
// static page can learn its own account's uuid without a dedicated "whoami" endpoint, which isn't
// in the contract. If the worker's actual redirect shape differs, only this file needs updating.
import { WORKER_ORIGIN, callWorker, WorkerUnreachableError } from './api.js';
import { renderErrorState } from './errors.js';
import { renderProfile } from './portfolio-render.js';

const STORAGE_KEY = 'lucrum-account-uuid';

const toggle = document.getElementById('theme-toggle');
function syncToggleLabel() {
  toggle.textContent = window.LucrumTheme.current() === 'dark' ? 'Light mode' : 'Dark mode';
}
syncToggleLabel();
toggle.addEventListener('click', () => { window.LucrumTheme.toggle(); syncToggleLabel(); });

const signinSlot = document.getElementById('signin-slot');
const signinBtn = document.getElementById('signin-btn');
const signinError = document.getElementById('signin-error');
const privacySlot = document.getElementById('privacy-slot');
const profileSlot = document.getElementById('profile-slot');

function storedUuid() {
  try { return localStorage.getItem(STORAGE_KEY); } catch (err) { return null; }
}
function storeUuid(uuid) {
  try { localStorage.setItem(STORAGE_KEY, uuid); } catch (err) { /* no persistence available */ }
}

// Pick up ?uuid= left by the OAuth callback's redirect, then clean the URL so a reload/share of
// this page doesn't leak or re-trigger it.
const params = new URLSearchParams(window.location.search);
const uuidFromRedirect = params.get('uuid');
if (uuidFromRedirect) {
  storeUuid(uuidFromRedirect);
  window.history.replaceState({}, '', window.location.pathname);
}

function renderPrivacyToggle(isPublic, uuid) {
  privacySlot.innerHTML = `
    <div class="privacy-toggle">
      <div class="desc">
        Your profile is currently <strong>${isPublic ? 'public' : 'private'}</strong>.
        A public profile is viewable by anyone at its shareable link with no login.
      </div>
      <button class="btn btn-secondary" id="toggle-public-btn" type="button">
        Make ${isPublic ? 'private' : 'public'}
      </button>
    </div>
    <p class="error-text" id="toggle-error" hidden></p>
  `;
  document.getElementById('toggle-public-btn').addEventListener('click', async () => {
    const errEl = document.getElementById('toggle-error');
    errEl.hidden = true;
    try {
      const { status, body } = await callWorker('/portfolio/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ public: !isPublic }),
      });
      if (status !== 200) {
        errEl.hidden = false;
        errEl.textContent = body.message || body.code || 'Could not update the privacy setting.';
        return;
      }
      loadProfile(uuid);
    } catch (err) {
      errEl.hidden = false;
      errEl.textContent = `The worker at ${WORKER_ORIGIN} did not respond. Check your connection and reload.`;
    }
  });
}

async function loadProfile(uuid) {
  let res;
  try {
    // credentials: 'include' (baked into callWorker) sends lucrum_session, so the worker
    // recognises the caller as the owner and returns data even if `public` is false.
    res = await callWorker(`/portfolio/${encodeURIComponent(uuid)}`);
  } catch (err) {
    if (err instanceof WorkerUnreachableError) return renderErrorState(profileSlot, 'unreachable');
    throw err;
  }
  const { status, body } = res;
  if (status === 403 && body.code === 'PORTFOLIO_PRIVATE') {
    // Session cookie didn't match this uuid as owner – the stored uuid is stale or wrong.
    signinSlot.hidden = false;
    signinError.hidden = false;
    signinError.textContent = 'Could not verify you as this account\'s owner. Sign in again.';
    return;
  }
  if (status !== 200) {
    renderErrorState(profileSlot, 'unknown');
    return;
  }
  signinSlot.hidden = true;
  renderPrivacyToggle(body.public, uuid);
  renderProfile(profileSlot, body);
}

signinBtn.addEventListener('click', async () => {
  signinError.hidden = true;
  const returnTo = encodeURIComponent(window.location.href.split('?')[0]);
  const url = `${WORKER_ORIGIN}/auth/mc-id/start?returnTo=${returnTo}`;
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
      // Unreadable body, most likely CORS on a non-redirect response – message above stands.
    }
    signinError.hidden = false;
    signinError.textContent = message;
  } catch (err) {
    window.location.href = url;
  }
});

const uuid = storedUuid();
if (uuid) {
  loadProfile(uuid);
} else {
  signinSlot.hidden = false;
}
