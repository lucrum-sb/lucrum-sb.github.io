// The viewer's own trading constraints – bankroll, Bazaar Flipper level, hands-on minutes per hour –
// shared by the market, signals and plan pages. Stored in localStorage as a per-viewer convenience:
// nothing here is authoritative, every read is guarded, and every page renders correctly without
// it (defaults below). No market logic (CLAUDE.md hard rule 2): the values are sent to the worker
// as query parameters, which does all the arithmetic.

const KEY = 'lucrum-player';
const DEFAULTS = { capital: 0, flipper: 0, active: 30 };
const listeners = new Set();

export function getSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      capital: Number.isFinite(raw.capital) && raw.capital > 0 ? raw.capital : DEFAULTS.capital,
      flipper: [0, 1, 2].includes(raw.flipper) ? raw.flipper : DEFAULTS.flipper,
      active: Number.isFinite(raw.active) && raw.active > 0 ? raw.active : DEFAULTS.active,
    };
  } catch (err) {
    return { ...DEFAULTS };
  }
}

export function saveSettings(next) {
  const merged = { ...getSettings(), ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch (err) {
    // Private window or blocked storage: the page still works for this visit.
  }
  for (const fn of listeners) fn(merged);
  return merged;
}

export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** "50m", "1.2b", "750k", "12,000,000" -> coins, or null. Input parsing, not market arithmetic. */
export function parseCoins(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/[,_\s]/g, '');
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/.exec(t);
  if (!m) return null;
  const mult = { '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2]];
  const v = Number(m[1]) * mult;
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

export function formatCoinsShort(n) {
  if (!(n > 0)) return '';
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}b`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(0)}k`;
  return String(n);
}

/**
 * Render the settings bar into `el`. Changes are saved on blur/enter/select and broadcast to
 * onSettingsChange listeners, so a page re-fetches once per real change.
 */
export function mountSettingsBar(el, { showActive = false } = {}) {
  const s = getSettings();
  el.classList.add('settings-bar');
  el.innerHTML = `
    <label class="setting">
      <span class="label">Your capital</span>
      <input class="input input-sm num" id="set-capital" inputmode="decimal" autocomplete="off"
             placeholder="e.g. 50m" value="${formatCoinsShort(s.capital)}" aria-describedby="set-capital-hint" />
    </label>
    <label class="setting">
      <span class="label">Bazaar Flipper</span>
      <select class="input input-sm" id="set-flipper">
        <option value="0"${s.flipper === 0 ? ' selected' : ''}>None · 14 slots</option>
        <option value="1"${s.flipper === 1 ? ' selected' : ''}>Level 1 · 21 slots</option>
        <option value="2"${s.flipper === 2 ? ' selected' : ''}>Level 2 · 28 slots</option>
      </select>
    </label>
    ${showActive ? `
    <label class="setting">
      <span class="label">Hands-on min / hour</span>
      <input class="input input-sm num" id="set-active" inputmode="numeric" autocomplete="off" value="${s.active}" />
    </label>` : ''}
    <span class="setting-hint dimmer" id="set-capital-hint">Leave capital empty to see every trade at full size.</span>
  `;
  const capital = el.querySelector('#set-capital');
  const commitCapital = () => {
    const v = capital.value.trim() === '' ? 0 : parseCoins(capital.value);
    if (v === null) {
      capital.setAttribute('aria-invalid', 'true');
      return;
    }
    capital.removeAttribute('aria-invalid');
    capital.value = formatCoinsShort(v);
    if (v !== getSettings().capital) saveSettings({ capital: v });
  };
  capital.addEventListener('blur', commitCapital);
  capital.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitCapital(); } });
  el.querySelector('#set-flipper').addEventListener('change', (e) => saveSettings({ flipper: Number(e.target.value) }));
  const active = el.querySelector('#set-active');
  if (active) {
    active.addEventListener('change', () => {
      const v = Number(active.value);
      if (Number.isFinite(v) && v > 0 && v <= 60) saveSettings({ active: v });
      else active.value = getSettings().active;
    });
  }
}
