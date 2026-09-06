// Worker status – GET /health and GET /version, neither of which the site read before. A gap in
// ingest quietly degrades every prediction that spans it, so this page states gaps plainly rather
// than reporting a green tick. docs/CONTRACTS.md's /health section: keep it honest, not
// always-green.
import { callWorker } from './api.js';
import { renderErrorState, classifyFailure } from './errors.js';
import { loadSnapshot } from './catalog.js';
import { startAgeTicker } from './shell.js';
import {
  formatInt, formatCompact, formatAge, formatLocalTime, formatDuration, formatPct, esc,
} from './format.js';

const body = document.getElementById('status-body');

/** `ageTs` marks the value as an age so the shared ticker keeps rewriting it – CLAUDE.md rule 12. */
function stat(label, value, cls = '', note = '', ageTs = null) {
  return `<div class="stat"><span class="label">${label}</span>
    <span class="value ${cls}"${ageTs ? ` data-age="${ageTs}"` : ''}>${value}</span>
    ${note ? `<p class="note">${note}</p>` : ''}</div>`;
}

/** A 24-hour strip: green where ticks landed, red where they did not. `gaps` is inferred from the
 * raw store's lastUpdated sequence, so a gap here is real missing data, not a missed cron alarm. */
function gapStrip(gaps, now) {
  const windowMs = 24 * 3600000;
  const start = now - windowMs;
  const recent = gaps.filter((g) => g.toTick > start);
  if (!recent.length) return '<div class="gap-bar"></div><p class="dimmer" style="font-size:0.75rem;margin:0">No gap in the trailing 24 hours.</p>';
  // The strip is a flex row of red segments on a green ground, so each segment's offset is
  // measured from the previous one's right edge rather than from the left of the bar.
  let cursor = 0;
  const laid = recent.slice().sort((a, b) => a.fromTick - b.fromTick).map((g) => {
    const from = Math.max(g.fromTick, start);
    const left = ((from - start) / windowMs) * 100;
    const width = Math.max(((Math.min(g.toTick, now) - from) / windowMs) * 100, 0.3);
    const gapLeft = Math.max(left - cursor, 0);
    cursor = left + width;
    return `<span class="miss" style="margin-left:${gapLeft}%;width:${width}%"></span>`;
  });
  const missed = recent.reduce((n, g) => n + g.missedTicks, 0);
  return `<div class="gap-bar">${laid.join('')}</div>
    <p class="dimmer" style="font-size:0.75rem;margin:0">
      ${formatInt(recent.length)} gaps in the trailing 24 hours, ${formatInt(missed)} missed 60-second ticks.
      Left edge is 24 hours ago, right edge is now.
    </p>`;
}

function render(health, version, snap) {
  const now = Date.now();
  const stale = now - health.lastIngestAt > 10 * 60 * 1000;
  const allGaps = health.gaps || [];
  const missedTotal = allGaps.reduce((n, g) => n + g.missedTicks, 0);
  const buildMatches = version && version.buildId === health.buildId;

  body.innerHTML = `
    <div class="card">
      <div class="grid grid-3">
        ${stat('Last ingest', esc(formatAge(health.lastIngestAt, now)), stale ? 'sell-c' : 'buy-c', esc(formatLocalTime(health.lastIngestAt)), health.lastIngestAt)}
        ${stat('Last ingest result', health.lastIngestOk === false ? 'failed' : 'ok', health.lastIngestOk === false ? 'neg' : 'pos', health.lastIngestOk === false ? 'the whole snapshot was dropped' : 'snapshot stored')}
        ${stat('Build', esc(health.buildId), '', version ? `/version says ${esc(version.buildId)}` : '/version unreachable')}
      </div>
      ${buildMatches === false ? '<p class="caveat">/health and /version report different build ids. A deploy did not land cleanly – check that before reading anything else on this page.</p>' : ''}
    </div>

    <h2 class="section-heading">Ingest continuity</h2>
    <div class="card">
      ${gapStrip(allGaps, now)}
      <div class="grid grid-3" style="margin-top:1.1rem">
        ${stat('Gaps recorded', formatInt(allGaps.length), allGaps.length ? 'sell-c' : 'buy-c', 'over the stored window')}
        ${stat('Missed ticks', formatInt(missedTotal), missedTotal ? 'sell-c' : 'buy-c', 'a tick is 60 seconds')}
        ${stat('Longest gap', allGaps.length ? esc(formatDuration(Math.max(...allGaps.map((g) => g.toTick - g.fromTick)))) : '–')}
      </div>
      ${allGaps.length ? `
        <div class="table-wrap" style="margin-top:1rem"><div class="table-scroll"><table class="ledger">
          <thead><tr><th>From</th><th>To</th><th class="num">Duration</th><th class="num">Missed ticks</th></tr></thead>
          <tbody>${allGaps.slice().sort((a, b) => b.fromTick - a.fromTick).map((g) => `
            <tr>
              <td class="num">${esc(formatLocalTime(g.fromTick))}</td>
              <td class="num">${esc(formatLocalTime(g.toTick))}</td>
              <td class="num">${esc(formatDuration(g.toTick - g.fromTick))}</td>
              <td class="num neg">${formatInt(g.missedTicks)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div></div>` : ''}
    </div>

    <h2 class="section-heading">Stored history</h2>
    <div class="card">
      <div class="grid grid-3">
        ${health.rows
    ? `${stat('Raw ticks', formatCompact(health.rows.raw))}
        ${stat('Hourly bars', formatCompact(health.rows.barsHourly), '', `oldest ${esc(formatLocalTime(health.oldestBar.hourly))}`)}
        ${stat('Five-minute bars', formatCompact(health.rows.barsFiveMin), '', `oldest ${esc(formatLocalTime(health.oldestBar.fiveMin))}`)}`
    : `${stat('Raw ticks', 'not counted')}
        ${stat('Hourly bars', 'not counted', '', `oldest ${esc(formatLocalTime(health.oldestBar.hourly))}`)}
        ${stat('Five-minute bars', 'not counted', '', `oldest ${esc(formatLocalTime(health.oldestBar.fiveMin))}`)}`}
      </div>
      ${health.rows ? '' : '<p class="caveat">The worker served this without the row counts – it only computes them when asked, and this page asked. Their absence means the count query itself failed, which on the free plan usually means the daily row-read budget is spent.</p>'}
      <p class="dim" style="font-size:0.82rem;margin:1rem 0 0">
        A range can only be charted or predicted as far back as the bars behind it reach. There are
        ${esc(formatDuration(now - health.oldestBar.hourly))} of hourly bars, so asking for six
        months charts the part that exists against the real six-month axis and leaves the rest of
        the window blank – it is not stretched to fill the range, and it is not a failure of the
        page. Prediction is the stricter case: a horizon the bars cannot support returns
        <span class="mono">INSUFFICIENT_HISTORY</span> rather than extrapolating.
      </p>
    </div>

    <h2 class="section-heading">Live market state</h2>
    <div class="card">
      ${snap ? `
        <div class="grid grid-3">
          ${stat('Products tracked', formatInt(Object.keys(snap.products || {}).length))}
          ${stat('Bazaar tax', formatPct(snap.taxRate, 2), '', 'taxRate(mayorState, flipperLevel)')}
          ${stat('Snapshot age', esc(formatAge(snap.lastUpdated, now)), '', '', snap.lastUpdated)}
        </div>
        <p class="dim" style="font-size:0.82rem;margin:1rem 0 0">
          ${snap.mayor && snap.mayor.name
    ? `Mayor <b>${esc(snap.mayor.name)}</b>${snap.mayor.minister && snap.mayor.minister.name ? `, minister <b>${esc(snap.mayor.minister.name)}</b>` : ''}, term ending ${esc(formatLocalTime(snap.mayor.termEnd))}. Perks: ${esc((snap.mayor.perks || []).join(', ') || 'none recorded')}.`
    : 'No mayor is recorded in the snapshot. Event windows that depend on a mayor perk cannot resolve until the election feed populates, so the calendar will look thin.'}
        </p>` : `<p class="dim" style="margin:0">The snapshot could not be loaded.</p>`}
    </div>

    <p class="dimmer" style="font-size:0.75rem;margin-top:1.25rem">
      Deployed ${version ? esc(formatLocalTime(version.deployedAt)) : '–'}${version && version.gitSha && version.gitSha !== 'unknown' ? ` · ${esc(version.gitSha)}` : ''}.
    </p>`;
}

Promise.all([
  // ?rows=1: this is the one page that shows the stored-row counts, so it is the one page that
  // pays for them. See api/health.js - the counts are full table scans against D1's row-read
  // budget, which is why they are opt-in rather than part of every /health call.
  callWorker('/health?rows=1'),
  callWorker('/version').catch(() => null),
  loadSnapshot().catch(() => null),
]).then(([healthRes, versionRes, snap]) => {
  if (healthRes.status !== 200) {
    renderErrorState(body, classifyFailure(null, healthRes.body) || 'unknown', { what: 'Worker health' });
    return;
  }
  render(healthRes.body, versionRes && versionRes.status === 200 ? versionRes.body : null, snap);
  startAgeTicker(body);
}).catch(() => {
  renderErrorState(body, 'unreachable');
});
