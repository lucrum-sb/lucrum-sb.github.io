// Collect – Lucas's devices pulling CoflNet history together (worker api/collect.js). Each device
// asks the worker for the next item, fetches it from CoflNet over its own connection at ~1.4
// requests a second, and posts the points back. Not linked from anywhere; needs the collect key.
// The request windows match tools/sim/sim.py exactly (a fixed grid, 2-hour points), so a browser and
// the PC pipeline can share the work. Temporary – remove with the worker routes once done.
import { callWorker } from './api.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FINE = 18 * HOUR;
const WEEK = 7 * DAY;
const GAP_MS = 1000 / 1.4; // ~84 a minute, under CoflNet's 100 per minute per connection

const $ = (id) => document.getElementById(id);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* none */ } } };
$('c-key').value = store.get('lucrum.collectKey') || '';
$('c-device').value = store.get('lucrum.collectDevice') || `browser-${Math.random().toString(36).slice(2, 6)}`;

let running = false;
let mine = 0;
let wake = null;
const recent = [];
const log = (line) => { const el = $('c-log'); el.textContent = `${new Date().toLocaleTimeString()} ${line}\n${el.textContent}`.split('\n').slice(0, 12).join('\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString().slice(0, 19);

/** The same windows tools/sim/sim.py asks for: 18h ones (5-minute points) for the last `fineDays`
 * and back to a week boundary, weekly ones (2-hour points) for the rest of `days`, on a fixed grid. */
function windows(endMs, fineDays, days) {
  const fineEnd = Math.floor(endMs / FINE) * FINE;
  const coarseEnd = Math.floor((fineEnd - fineDays * DAY) / WEEK) * WEEK;
  const out = [];
  if (fineDays === 0) out.push([coarseEnd, endMs]);
  for (let t = fineDays ? fineEnd : coarseEnd; t > coarseEnd; t -= FINE) out.push([t - FINE, t]);
  for (let t = coarseEnd; t > endMs - days * DAY; t -= WEEK) out.push([t - WEEK, t]);
  return out;
}

async function gzipJson(value) {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

async function cofl(item, start, end) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const began = Date.now();
    try {
      const res = await fetch(`https://sky.coflnet.com/api/bazaar/${encodeURIComponent(item)}/history?start=${iso(start)}&end=${iso(end)}`);
      recent.push(Date.now());
      if (res.status === 429) { log(`CoflNet asked to slow down – waiting ${15 * (attempt + 1)}s`); await sleep(15_000 * (attempt + 1)); continue; }
      if (!res.ok) { await sleep(3000 * (attempt + 1)); continue; }
      const text = await res.text();
      await sleep(Math.max(0, GAP_MS - (Date.now() - began)));
      return text.trim() ? JSON.parse(text) : [];
    } catch {
      await sleep(3000 * (attempt + 1));
    }
  }
  throw new Error(`CoflNet kept failing for ${item}`);
}

async function status(headers) {
  const { status: code, body } = await callWorker('/collect/status', { headers });
  if (code !== 200) return;
  $('c-all').textContent = `${body.done ?? 0} / ${body.items ?? 0}`;
  $('c-all-note').textContent = `items done · ${body.working ?? 0} in progress · ${(body.lastHourByDevice || []).map((d) => `${d.device} ${d.done}`).join(', ') || 'none in the last hour'}`;
}

async function run() {
  const key = $('c-key').value.trim();
  const device = $('c-device').value.trim() || 'browser';
  store.set('lucrum.collectKey', key);
  store.set('lucrum.collectDevice', device);
  const headers = { 'x-collect-key': key };
  try { wake = await navigator.wakeLock?.request('screen'); } catch { wake = null; }
  while (running) {
    const { status: code, body } = await callWorker(`/collect/next?device=${encodeURIComponent(device)}`, { headers });
    if (code !== 200) { log(code === 403 ? 'The collect key is wrong.' : `The worker said ${code}.`); break; }
    if (!body.item) { log('The queue is empty – everything is collected.'); break; }
    const item = body.item;
    const ws = windows(Math.floor((Date.now() - 2 * HOUR) / HOUR) * HOUR, body.fineDays ?? 0, body.days ?? 365);
    const points = [];
    for (let i = 0; i < ws.length && running; i++) {
      $('c-now').textContent = item;
      $('c-now-note').textContent = `window ${i + 1}/${ws.length}`;
      points.push(...(await cofl(item, ws[i][0], ws[i][1])));
      while (recent.length && recent[0] < Date.now() - 60_000) recent.shift();
      $('c-rate').textContent = String(recent.length);
    }
    // CoflNet's 2-hour summaries have holes (a day or a week with one point) where its 5-minute data
    // is complete: every gap over 6 hours is asked for again in 18h windows, as tools/sim/sim.py does.
    const times = points.map((p) => Date.parse(String(p.timestamp).endsWith('Z') ? p.timestamp : `${p.timestamp}Z`)).filter(Number.isFinite).sort((x, y) => x - y);
    const holes = [];
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] <= 6 * HOUR) continue;
      for (let w = Math.floor(times[i - 1] / FINE) * FINE; w < times[i]; w += FINE) holes.push([w, w + FINE]);
    }
    for (let i = 0; i < holes.length && running; i++) {
      $('c-now-note').textContent = `filling gaps ${i + 1}/${holes.length}`;
      points.push(...(await cofl(item, holes[i][0], holes[i][1])));
    }
    if (!running) { log(`Stopped during ${item}; it goes back in the queue in 15 minutes.`); break; }
    $('c-now-note').textContent = 'uploading';
    const res = await callWorker(`/collect/done?item=${encodeURIComponent(item)}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-body-gzip': '1' }, body: await gzipJson(points) });
    if (res.status !== 200) { log(`Upload of ${item} failed (${res.status}); it goes back in the queue.`); continue; }
    mine += 1;
    $('c-mine').textContent = String(mine);
    log(`${item}: ${res.body.points.toLocaleString()} points`);
    await status(headers);
  }
  running = false;
  $('c-start').textContent = 'Start';
  $('c-now').textContent = 'idle';
  $('c-now-note').textContent = '';
  try { await wake?.release(); } catch { /* none */ }
}

$('c-start').addEventListener('click', () => {
  if (running) { running = false; $('c-start').textContent = 'Stopping…'; return; }
  running = true;
  $('c-start').textContent = 'Stop';
  run().catch((err) => { log(String(err.message || err)); running = false; $('c-start').textContent = 'Start'; });
});
if ($('c-key').value) status({ 'x-collect-key': $('c-key').value }).catch(() => {});
