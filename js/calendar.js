// Event calendar – GET /calendar per docs/CONTRACTS.md. A quiet list, not a month grid: "what is
// coming and when" for a desk. Countdowns re-render every second per CLAUDE.md rule 12 – a value
// that is correct once and then frozen is a bug, not a detail.
//
// The window is grouped by event id rather than listed flat, because it isn't small: 30 days
// returns ~1500 windows, 1440 of which are the hourly Dark Auction and Jacob's Contest. A flat
// list of those is unreadable and unscrollable. Each group shows its next occurrence and expands
// to the rest, so nothing the worker returns is dropped.
import { callWorker, WorkerUnreachableError } from './api.js';
import { renderErrorState, classifyFailure } from './errors.js';
import { mountStatusStrip } from './shell.js';
import { formatDuration, formatLocalTime, formatInt, esc } from './format.js';

const slot = document.getElementById('calendar-slot');
const spanTabs = document.querySelectorAll('#span-tabs .tab');

/** How many occurrences an expanded group lists before it stops – 720 rows helps nobody, and the
 * cadence line already says what the rest of them are. */
const OCCURRENCE_LIMIT = 24;

let events = [];
let days = 30;
let tickHandle = null;

mountStatusStrip(document.getElementById('status-strip'));

function phase(ev, now) {
  if (now < ev.start) return 'future';
  if (now < ev.end) return 'live';
  return 'past';
}

function countdownText(ev, now) {
  const p = phase(ev, now);
  if (p === 'future') return `opens in ${formatDuration(ev.start - now)}`;
  if (p === 'live') return `live · closes in ${formatDuration(ev.end - now)}`;
  return 'closed';
}

/** Groups the window's occurrences by event id, in order of whichever occurrence matters now: the
 * one running, else the next one to open, else the last one that closed. */
function groupEvents(all, now) {
  const byId = new Map();
  for (const ev of all) {
    if (!byId.has(ev.id)) byId.set(ev.id, { id: ev.id, label: ev.label, source: ev.source, occurrences: [] });
    byId.get(ev.id).occurrences.push(ev);
  }
  const groups = [...byId.values()].map((g) => {
    g.occurrences.sort((a, b) => a.start - b.start);
    const live = g.occurrences.find((e) => now >= e.start && now < e.end);
    const next = g.occurrences.find((e) => e.start > now);
    g.current = live || next || g.occurrences[g.occurrences.length - 1];
    g.cadence = cadenceOf(g.occurrences);
    return g;
  });
  return groups.sort((a, b) => a.current.start - b.current.start);
}

/** The typical gap between consecutive openings, or null when there is only one occurrence. Median
 * rather than mean so one long seasonal gap doesn't misdescribe an hourly event. */
function cadenceOf(occurrences) {
  if (occurrences.length < 2) return null;
  const gaps = occurrences.slice(1).map((e, i) => e.start - occurrences[i].start).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function occurrenceRow(ev, now, cls = '') {
  return `<li class="event-row is-${phase(ev, now)} ${cls}" data-start="${ev.start}" data-end="${ev.end}">
      <div>
        <span class="event-name">${esc(ev.label)}</span>
        <span class="event-source">${esc(ev.id)} · ${esc(ev.source)}</span>
      </div>
      <div class="event-when">
        <span class="event-countdown">${esc(countdownText(ev, now))}</span>
        <span class="event-time">${esc(formatLocalTime(ev.start))} &ndash; ${esc(formatLocalTime(ev.end))}</span>
      </div>
    </li>`;
}

function groupRow(g, now) {
  const ev = g.current;
  const more = g.occurrences.length - 1;
  const meta = [
    esc(g.id),
    esc(g.source),
    g.cadence ? `every ${esc(formatDuration(g.cadence))}` : 'once in this window',
    more > 0 ? `${formatInt(g.occurrences.length)} windows` : null,
  ].filter(Boolean).join(' · ');

  return `
    <li class="event-row is-${phase(ev, now)}" data-start="${ev.start}" data-end="${ev.end}">
      <div>
        <span class="event-name">
          ${more > 0 ? `<button class="expand-btn" type="button" data-id="${esc(g.id)}" aria-expanded="false" aria-label="Show every ${esc(g.label)} window">&#9656;</button>` : ''}
          ${esc(g.label)}
        </span>
        <span class="event-source">${meta}</span>
      </div>
      <div class="event-when">
        <span class="event-countdown">${esc(countdownText(ev, now))}</span>
        <span class="event-time">${esc(formatLocalTime(ev.start))} &ndash; ${esc(formatLocalTime(ev.end))}</span>
      </div>
    </li>
    ${more > 0 ? `<li class="event-occurrences" data-for="${esc(g.id)}" hidden><ul class="event-list nested"></ul></li>` : ''}`;
}

function renderList() {
  const now = Date.now();
  if (events.length === 0) {
    slot.innerHTML = `<p class="empty-state">No event window resolves in the next ${days} days.</p>`;
    return;
  }
  const groups = groupEvents(events, now);

  slot.innerHTML = `
    <div class="table-wrap">
      <ul class="event-list">${groups.map((g) => groupRow(g, now)).join('')}</ul>
    </div>
    <p class="dimmer" style="font-size:0.75rem;margin-top:0.6rem">
      ${formatInt(groups.length)} distinct events, ${formatInt(events.length)} windows in the next
      ${days} days. Times are your local timezone, converted at render – the worker stores and
      computes everything in UTC epoch milliseconds.
    </p>`;

  slot.querySelectorAll('.expand-btn').forEach((btn) => {
    btn.addEventListener('click', () => toggleGroup(btn, groups));
  });
}

function toggleGroup(btn, groups) {
  const g = groups.find((x) => x.id === btn.dataset.id);
  const panel = slot.querySelector(`.event-occurrences[data-for="${CSS.escape(g.id)}"]`);
  const open = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', String(!open));
  panel.hidden = open;
  if (open) return;

  const now = Date.now();
  const from = Math.max(g.occurrences.indexOf(g.current), 0);
  const list = g.occurrences.slice(from, from + OCCURRENCE_LIMIT);
  const remaining = g.occurrences.length - from - list.length;
  panel.querySelector('.event-list').innerHTML = list.map((ev) => occurrenceRow(ev, now)).join('')
    + (remaining > 0
      ? `<li class="event-row"><div><span class="event-source">${formatInt(remaining)} further windows in this range, every ${esc(formatDuration(g.cadence))} – shorten the range to see them individually.</span></div></li>`
      : '');
}

/** Retargets only the text and the row class – re-rendering the whole list every second would
 * throw away scroll position, selection and which groups are expanded. */
function tickCountdowns() {
  const now = Date.now();
  slot.querySelectorAll('.event-row[data-start]').forEach((row) => {
    const ev = { start: Number(row.dataset.start), end: Number(row.dataset.end) };
    const p = phase(ev, now);
    row.classList.remove('is-future', 'is-live', 'is-past');
    row.classList.add(`is-${p}`);
    const label = row.querySelector('.event-countdown');
    if (label) label.textContent = countdownText(ev, now);
  });
}

async function load() {
  const from = Date.now();
  const to = from + days * 86400000;
  slot.innerHTML = '<p class="loading-state">Loading the calendar…</p>';
  try {
    const { status, body } = await callWorker(`/calendar?from=${from}&to=${to}`);
    if (status !== 200) {
      renderErrorState(slot, classifyFailure(null, body) || 'unknown', { what: 'The event calendar' });
      return;
    }
    events = body.events || [];
  } catch (err) {
    if (err instanceof WorkerUnreachableError) {
      renderErrorState(slot, 'unreachable');
      return;
    }
    throw err;
  }
  renderList();
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(tickCountdowns, 1000);
}

window.addEventListener('pagehide', () => clearInterval(tickHandle));

spanTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    days = Number(btn.dataset.days);
    spanTabs.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    load();
  });
});

load();
