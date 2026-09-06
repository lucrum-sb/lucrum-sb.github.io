// The app shell: the one header every page shares, the theme toggle, and the global item search
// palette. Imported by every page script – nothing here is page-specific.
//
// docs/BRAND.md's layout rule: search is a permanent global control, not a page, because any of
// the bazaar's ~2000 products has to be reachable from anywhere. `document.body.dataset.base`
// carries the relative path back to the site root ('' at the root, '../' one level down), so the
// same code links correctly from every depth without hard-coding an absolute origin.
import { loadItemIds, searchItems } from './catalog.js';
import { callWorker } from './api.js';
import { itemLabel, formatAge, esc } from './format.js';

const base = document.body.dataset.base || '';

export function itemHref(id) {
  return `${base}item/?id=${encodeURIComponent(id)}`;
}

/* --- Theme toggle ----------------------------------------------------------------------------- */

const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>';

function syncThemeButton(btn) {
  const dark = window.LucrumTheme.current() === 'dark';
  btn.innerHTML = dark ? SUN : MOON;
  btn.setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme');
  btn.title = btn.getAttribute('aria-label');
}

function mountThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  syncThemeButton(btn);
  btn.addEventListener('click', () => {
    const next = window.LucrumTheme.toggle();
    syncThemeButton(btn);
    window.LucrumTheme._notify(next); // canvases read CSS vars at draw time – they must repaint
  });
}

/* --- Search palette --------------------------------------------------------------------------- */

let paletteEl = null;
let inputEl = null;
let listEl = null;
let ids = null;
let results = [];
let selected = 0;

function buildPalette() {
  const wrap = document.createElement('div');
  wrap.className = 'palette-backdrop';
  wrap.hidden = true;
  wrap.innerHTML = `
    <div class="palette" role="dialog" aria-modal="true" aria-label="Find a bazaar item">
      <input id="palette-input" type="text" autocomplete="off" spellcheck="false"
             placeholder="Find a bazaar item – name or id" aria-controls="palette-results" />
      <ul class="palette-results" id="palette-results" role="listbox"></ul>
      <div class="palette-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>enter</kbd> open</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  paletteEl = wrap;
  inputEl = wrap.querySelector('#palette-input');
  listEl = wrap.querySelector('#palette-results');

  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) closePalette(); });
  inputEl.addEventListener('input', () => { render(); });
  inputEl.addEventListener('keydown', onKeydown);
  listEl.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) { e.preventDefault(); go(li.dataset.id); }
  });
}

function render() {
  if (!ids) {
    listEl.innerHTML = '<li class="dimmer">Loading the product catalogue…</li>';
    return;
  }
  results = searchItems(ids, inputEl.value, 40);
  selected = 0;
  if (results.length === 0) {
    listEl.innerHTML = `<li class="dimmer">No product id matches “${esc(inputEl.value)}”.</li>`;
    return;
  }
  listEl.innerHTML = results
    .map((id, i) => `<li role="option" data-id="${esc(id)}" aria-selected="${i === 0}">
        <span>${esc(itemLabel(id))}</span><span class="id">${esc(id)}</span>
      </li>`)
    .join('');
}

function moveSelection(delta) {
  if (results.length === 0) return;
  selected = (selected + delta + results.length) % results.length;
  const items = listEl.querySelectorAll('li[data-id]');
  items.forEach((li, i) => li.setAttribute('aria-selected', String(i === selected)));
  const active = items[selected];
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function onKeydown(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); if (results[selected]) go(results[selected]); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
}

function go(id) {
  window.location.href = itemHref(id);
}

export function openPalette() {
  if (!paletteEl) buildPalette();
  paletteEl.hidden = false;
  inputEl.value = '';
  render();
  inputEl.focus();
  if (!ids) {
    loadItemIds().then((list) => { ids = list; if (!paletteEl.hidden) render(); })
      .catch(() => { listEl.innerHTML = '<li class="dimmer">Could not reach the worker to load the catalogue.</li>'; });
  }
}

function closePalette() {
  if (paletteEl) paletteEl.hidden = true;
}

function mountSearch() {
  const trigger = document.getElementById('search-trigger');
  if (trigger) trigger.addEventListener('click', openPalette);

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openPalette();
    } else if (e.key === '/' && !typing && (!paletteEl || paletteEl.hidden)) {
      e.preventDefault();
      openPalette();
    } else if (e.key === 'Escape') {
      closePalette();
    }
  });
}

/* --- Live ages ----------------------------------------------------------------------------------
   CLAUDE.md rule 12: an age that is correct once and then frozen is a bug. Any element rendered as
   `<b data-age="${epochMs}">` has its text rewritten each second – text only, so surrounding markup,
   selection and expanded rows survive. */

/** Rewrites every `[data-age]` under `root` once. Exported for the tests as much as for callers. */
export function tickAges(root) {
  const now = Date.now();
  root.querySelectorAll('[data-age]').forEach((el) => {
    const ts = Number(el.dataset.age);
    if (ts) el.textContent = formatAge(ts, now);
  });
}

/** Starts the per-second rewrite for a container that renders ages but has no strip of its own. */
export function startAgeTicker(root) {
  tickAges(root);
  const timer = setInterval(() => tickAges(root), 1000);
  window.addEventListener('pagehide', () => clearInterval(timer));
  return () => clearInterval(timer);
}

/* --- Status strip ------------------------------------------------------------------------------
   Freshness, in the reader's local clock and ticking – CLAUDE.md rule 12. Whatever the page
   already knows (tax rate, the pass it is displaying) is passed in; ingest health comes from
   GET /health, which is small and uncached. */

export function mountStatusStrip(el, extra = {}) {
  if (!el) return;
  const state = { ...extra, lastIngestAt: null, ingestOk: true, buildId: null, reachable: true };

  // Every cell is rebuilt from `state` on each paint, so the ages tick instead of freezing at
  // whatever they were when the page loaded.
  function paint() {
    const now = Date.now();
    const { lastIngestAt } = state;
    const stale = lastIngestAt !== null && now - lastIngestAt > 10 * 60 * 1000;
    const cells = [`
      <span class="cell">
        <span class="status-dot ${!state.reachable ? 'is-loss' : lastIngestAt === null ? '' : stale ? 'is-warn' : 'is-gain'}"></span>
        Bazaar data <b data-age="${lastIngestAt ?? ''}">${!state.reachable ? 'unreachable' : lastIngestAt === null ? '…' : esc(formatAge(lastIngestAt, now))}</b>
      </span>
    `];
    if (state.taxRate !== undefined && state.taxRate !== null) {
      cells.push(`<span class="cell">Tax <b>${(state.taxRate * 100).toFixed(2)}%</b></span>`);
    }
    if (state.mayor) {
      const m = state.mayor;
      cells.push(`<span class="cell">Mayor <b>${esc(m.name || 'not elected')}</b>${
        m.minister && m.minister.name ? ` <span class="dimmer">· minister ${esc(m.minister.name)}</span>` : ''
      }</span>`);
    }
    if (state.generatedAt) {
      cells.push(`<span class="cell">Scored <b data-age="${state.generatedAt}">${esc(formatAge(state.generatedAt, now))}</b></span>`);
    }
    if (!state.ingestOk) {
      cells.push('<span class="cell"><span class="status-dot is-loss"></span>Last ingest failed</span>');
    }
    if (state.buildId) {
      cells.push(`<span class="cell spacer-left dimmer">Build <b>${esc(state.buildId)}</b></span>`);
    }
    el.innerHTML = cells.join('');
  }

  paint();
  callWorker('/health').then(({ status, body }) => {
    if (status !== 200) return;
    state.lastIngestAt = body.lastIngestAt;
    state.ingestOk = body.lastIngestOk !== false;
    state.buildId = body.buildId;
    paint();
  }).catch(() => {
    state.reachable = false;
    paint();
  });

  // The ages are printed down to the second, so they have to move every second – a 15s repaint
  // leaves "1m 10s ago" reading wrong for fourteen of them. Retarget just the text, and rebuild
  // the whole strip only occasionally, for the staleness dot's one transition.
  let sinceRepaint = 0;
  const timer = setInterval(() => {
    if ((sinceRepaint += 1) >= 15) { sinceRepaint = 0; paint(); } else tickAges(el);
  }, 1000);
  window.addEventListener('pagehide', () => clearInterval(timer));
  return { update(patch) { Object.assign(state, patch); paint(); } };
}

/* --- Init -------------------------------------------------------------------------------------- */

mountThemeToggle();
mountSearch();
