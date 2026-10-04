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
import { renderErrorState, classifyFailure, failureText } from './errors.js';
import { renderProfile } from './portfolio-render.js';
import { esc, itemLabel, formatCoins, formatInt } from './format.js';
import './shell.js';

const STORAGE_KEY = 'lucrum-account-uuid';

const signinSlot = document.getElementById('signin-slot');
const signinBtn = document.getElementById('signin-btn');
const signinError = document.getElementById('signin-error');
const privacySlot = document.getElementById('privacy-slot');
const profileSlot = document.getElementById('profile-slot');
const tradeSlot = document.getElementById('trade-slot');

/** A signal the viewer chose to track on the signals page (js/signals.js writes it). */
const DRAFT_KEY = 'lucrum-track-draft';
function takeDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) { return null; }
}
function clearDraft() {
  try { sessionStorage.removeItem(DRAFT_KEY); } catch (err) { /* nothing to clear */ }
}

const TYPES = ['position', 'spread', 'craft', 'event', 'npc'];
const ENTRY_METHODS = [['buy_order', 'Buy order'], ['instant_buy', 'Instant buy']];

/**
 * "Record a trade": what actually happened, entered by hand – the manual path docs/CONTRACTS.md
 * requires alongside chat parsing. When it comes from a tracked signal, the signal's own figures
 * ride along as `planned` and are shown, never substituted for the actual entry (rule 13).
 */
function renderTradeForm(uuid) {
  const draft = takeDraft();
  const planned = draft && draft.planned;
  tradeSlot.innerHTML = `
    <details class="card trade-card"${draft ? ' open' : ''}>
      <summary><span class="label">Record a trade</span>
        <span class="dim" style="font-size:0.82rem">${draft
    ? `tracking the ${esc(draft.type)} signal on ${esc(itemLabel(draft.item))}`
    : 'enter a fill by hand – chat parsing in the mod does this automatically once it ships'}</span></summary>
      <form class="trade-form" id="trade-form">
        <label class="filter"><span class="label">Item id</span>
          <input class="input input-sm" name="item" required autocomplete="off" spellcheck="false"
                 value="${esc(draft ? draft.item : '')}" placeholder="ENCHANTED_DIAMOND" /></label>
        <label class="filter"><span class="label">Type</span>
          <select class="input input-sm" name="type">${TYPES.map((t) => `<option${draft && draft.type === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="filter"><span class="label">Quantity</span>
          <input class="input input-sm num" name="qty" inputmode="numeric" required value="${draft ? esc(String(draft.qty)) : ''}" /></label>
        <label class="filter"><span class="label">Actual entry price</span>
          <input class="input input-sm num" name="entryPrice" inputmode="decimal" required
                 placeholder="${planned ? `planned ${esc(String(planned.entryPrice))}` : 'coins per unit'}" /></label>
        <label class="filter"><span class="label">How it filled</span>
          <select class="input input-sm" name="entryMethod">${ENTRY_METHODS.map(([v, l]) => `<option value="${v}"${planned && planned.entryMethod === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <button class="btn btn-primary btn-sm" type="submit">Record entry</button>
        ${draft ? '<button class="btn btn-sm" type="button" id="drop-draft">Not now</button>' : ''}
        <p class="error-text" id="trade-error" hidden></p>
      </form>
      ${planned ? `<p class="dim" style="font-size:0.8rem;margin:0.6rem 0 0">
        The signal planned ${formatInt(draft.qty)} at ${formatCoins(planned.entryPrice)}${planned.exitPrice ? `, out at ${formatCoins(planned.exitPrice)}` : ''}.
        That plan is stored as <b>planned</b>; enter the price you actually paid.</p>` : ''}
    </details>`;

  const form = document.getElementById('trade-form');
  const drop = document.getElementById('drop-draft');
  if (drop) drop.addEventListener('click', () => { clearDraft(); renderTradeForm(uuid); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('trade-error');
    errEl.hidden = true;
    const qty = Number(String(form.qty.value).replace(/,/g, ''));
    const entryPrice = Number(String(form.entryPrice.value).replace(/,/g, ''));
    const item = form.item.value.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!item || !(qty > 0) || !(entryPrice > 0)) {
      errEl.hidden = false;
      errEl.textContent = 'An item id, a quantity and the price you actually paid are all needed.';
      return;
    }
    const payload = {
      item, type: form.type.value, direction: 'long', qty,
      actual: { entryPrice, entryMethod: form.entryMethod.value, confirmedBy: 'manual', confirmedAt: Date.now() },
    };
    if (draft && draft.item === item) {
      payload.signalId = draft.signalId;
      payload.planned = draft.planned;
    }
    form.querySelector('button[type=submit]').disabled = true;
    try {
      const { status, body } = await callWorker('/portfolio/positions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (status !== 201) {
        errEl.hidden = false;
        errEl.textContent = failureText(classifyFailure(null, body) || 'unknown', { what: 'Recording the trade' });
        form.querySelector('button[type=submit]').disabled = false;
        return;
      }
      clearDraft();
      renderTradeForm(uuid);
      loadProfile(uuid);
    } catch (err) {
      errEl.hidden = false;
      errEl.textContent = failureText('unreachable');
      form.querySelector('button[type=submit]').disabled = false;
    }
  });
}

/** PATCH the actual exit; returns an error message for the inline form, or null on success. */
async function closePosition(uuid, id, actual) {
  try {
    const { status, body } = await callWorker(`/portfolio/positions/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actual }),
    });
    if (status !== 200) return failureText(classifyFailure(null, body) || 'unknown', { what: 'Closing the position' });
    loadProfile(uuid);
    return null;
  } catch (err) {
    return failureText('unreachable');
  }
}

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
  // data-base is the relative path back to the site root, so this resolves correctly whether the
  // site is served from a domain root or from a GitHub Pages project subpath.
  const shareUrl = new URL(`${document.body.dataset.base}p/?uuid=${encodeURIComponent(uuid)}`, window.location.href).href;
  privacySlot.innerHTML = `
    <div class="privacy-toggle">
      <span class="status-dot ${isPublic ? 'is-gain' : ''}"></span>
      <div class="desc">
        Your profile is <strong>${isPublic ? 'public' : 'private'}</strong>.
        ${isPublic
    ? `Anyone with the link can read it without signing in: <a href="${esc(shareUrl)}">${esc(shareUrl)}</a>`
    : 'Only you can read it. Private means private – there is no partial or redacted view.'}
      </div>
      <button class="btn btn-sm" id="toggle-public-btn" type="button">
        Make ${isPublic ? 'private' : 'public'}
      </button>
    </div>
    <p class="error-text" id="toggle-error" hidden></p>`;

  document.getElementById('toggle-public-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const errEl = document.getElementById('toggle-error');
    errEl.hidden = true;
    btn.disabled = true;
    try {
      const { status, body } = await callWorker('/portfolio/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ public: !isPublic }),
      });
      if (status !== 200) {
        btn.disabled = false;
        errEl.hidden = false;
        errEl.textContent = failureText(classifyFailure(null, body) || 'unknown', {
          what: 'The privacy setting',
        });
        return;
      }
      loadProfile(uuid);
    } catch (err) {
      btn.disabled = false;
      errEl.hidden = false;
      errEl.textContent = failureText('unreachable');
    }
  });
}

async function loadProfile(uuid) {
  profileSlot.innerHTML = '<p class="loading-state">Loading your portfolio…</p>';
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
  if (status === 403 || status === 401) {
    // Session cookie didn't match this uuid as owner – the stored uuid is stale, or the session
    // expired. Either way the fix is the same: sign in again.
    profileSlot.innerHTML = '';
    privacySlot.innerHTML = '';
    signinSlot.hidden = false;
    signinError.hidden = false;
    signinError.textContent = 'Could not verify you as this account’s owner. Sign in again.';
    return;
  }
  if (status !== 200) {
    privacySlot.innerHTML = '';
    renderErrorState(profileSlot, classifyFailure(null, body) || 'unknown', { uuid, what: 'Your portfolio' });
    return;
  }
  signinSlot.hidden = true;
  renderPrivacyToggle(body.public, uuid);
  if (!tradeSlot.innerHTML) renderTradeForm(uuid);
  renderProfile(profileSlot, body, { owner: true, onClose: (id, actual) => closePosition(uuid, id, actual) });
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
