// Public profile page – GET /portfolio/<uuid>, no login required, per docs/CONTRACTS.md. Reads
// `uuid` from the query string (see 404.html's redirect for the `/p/<uuid>` path shape GitHub
// Pages can't route directly, since there is no server-side slug resolution here – a documented
// deviation from CONTRACTS.md's illustrative `/p/<ign>` example, not from the endpoint contract
// itself, which is keyed by uuid).
import { callWorker, WorkerUnreachableError } from './api.js';
import { renderErrorState } from './errors.js';
import { renderProfile } from './portfolio-render.js';

const toggle = document.getElementById('theme-toggle');
function syncToggleLabel() {
  toggle.textContent = window.LucrumTheme.current() === 'dark' ? 'Light mode' : 'Dark mode';
}
syncToggleLabel();
toggle.addEventListener('click', () => { window.LucrumTheme.toggle(); syncToggleLabel(); });

const slot = document.getElementById('profile-slot');
const params = new URLSearchParams(window.location.search);
const uuid = params.get('uuid');

async function load() {
  if (!uuid) {
    renderErrorState(slot, 'profile_not_found', { uuid: '(none given)' });
    return;
  }
  let res;
  try {
    res = await callWorker(`/portfolio/${encodeURIComponent(uuid)}`);
  } catch (err) {
    if (err instanceof WorkerUnreachableError) return renderErrorState(slot, 'unreachable');
    throw err;
  }
  const { status, body } = res;
  if (status === 403 && body.code === 'PORTFOLIO_PRIVATE') {
    renderErrorState(slot, 'portfolio_private');
    return;
  }
  if (status === 404) {
    renderErrorState(slot, 'profile_not_found', { uuid });
    return;
  }
  if (status !== 200) {
    renderErrorState(slot, 'unknown');
    return;
  }
  renderProfile(slot, body);
}

load();
