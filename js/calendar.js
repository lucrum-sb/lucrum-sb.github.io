// Event calendar – GET /calendar per docs/CONTRACTS.md. A quiet list, not a grid widget: "what's
// coming and when" for a private desk, not a month view. Countdown re-renders on a tick per
// CLAUDE.md rule 12 – a value that's correct once and then frozen is a bug.
import { callWorker, WorkerUnreachableError } from './api.js';
import { renderErrorState, classifyFailure } from './errors.js';
import { formatDuration, formatLocalTime } from './format.js';

const toggle = document.getElementById('theme-toggle');
function syncToggleLabel() {
  toggle.textContent = window.LucrumTheme.current() === 'dark' ? 'Light mode' : 'Dark mode';
}
syncToggleLabel();
toggle.addEventListener('click', () => { window.LucrumTheme.toggle(); syncToggleLabel(); });

const slot = document.getElementById('calendar-slot');
let events = [];
let tickHandle = null;

function renderList() {
  slot.innerHTML = '';
  if (events.length === 0) {
    slot.innerHTML = '<p class="loading-state">No event windows in the next 30 days.</p>';
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'event-list';
  const now = Date.now();
  const sorted = events.slice().sort((a, b) => a.start - b.start);
  for (const ev of sorted) {
    const li = document.createElement('li');
    li.className = 'event-row';
    const status = now < ev.start ? `Opens in ${formatDuration(ev.start - now)}`
      : now < ev.end ? `Live &middot; closes in ${formatDuration(ev.end - now)}`
      : 'Closed';
    li.innerHTML = `
      <div>
        <span class="event-name">${ev.label}</span>
        <span class="event-source">${ev.source}</span>
      </div>
      <div class="event-when" data-start="${ev.start}" data-end="${ev.end}">
        <span class="event-countdown">${status}</span>
        <span class="event-time">${formatLocalTime(ev.start)} &ndash; ${formatLocalTime(ev.end)}</span>
      </div>
    `;
    ul.appendChild(li);
  }
  slot.appendChild(ul);
}

function tickCountdowns() {
  const now = Date.now();
  document.querySelectorAll('.event-when').forEach((el) => {
    const start = Number(el.dataset.start);
    const end = Number(el.dataset.end);
    const label = el.querySelector('.event-countdown');
    if (!label) return;
    if (now < start) label.textContent = `Opens in ${formatDuration(start - now)}`;
    else if (now < end) label.textContent = `Live · closes in ${formatDuration(end - now)}`;
    else label.textContent = 'Closed';
  });
}

async function load() {
  const from = Date.now();
  const to = from + 30 * 86400000;
  try {
    const { status, body } = await callWorker(`/calendar?from=${from}&to=${to}`);
    if (status !== 200) {
      renderErrorState(slot, classifyFailure(null, body) || 'unknown');
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
  tickHandle = setInterval(tickCountdowns, 30000);
}

load();
