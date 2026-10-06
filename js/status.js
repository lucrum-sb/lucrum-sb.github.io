// Worker status – GET /health, GET /version and GET /model. A gap in ingest quietly degrades every
// prediction that spans it, so this page states gaps plainly rather than reporting a green tick.
// docs/CONTRACTS.md's /health section: keep it honest, not always-green. The same goes for the
// model check: a negative skill or a sub-50% spread hit rate is stated as what it is.
import { callWorker } from './api.js';
import { renderErrorState, classifyFailure } from './errors.js';
import { loadSnapshot } from './catalog.js';
import { startAgeTicker, itemHref } from './shell.js';
import {
  formatInt, formatCompact, formatAge, formatLocalTime, formatDuration, formatPct, formatPctSigned,
  itemLabel, signClass, esc,
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

/** docs/PLAN.md Phase 5: the sweep's skill is reported honestly – negative means the forecast lost
 * to "the price stays where it is", and the page says so in words rather than just a red number. */
function sweepCard(sweep, now) {
  if (!sweep) {
    return '<p class="dim" style="margin:0">No backtest sweep has run yet. The worker runs one daily over stored hourly bars.</p>';
  }
  const m = sweep.summary || {};
  if (!m.scored && sweep.trainedTo) {
    return `<p class="dim" style="margin:0">No out-of-sample forecasts to score yet. The sweep only scores forecasts made after the model's training data ends (${esc(formatLocalTime(sweep.trainedTo))}), plus a full ${esc(formatDuration(sweep.futureMs))} to see what happened; the first appear a few days after a retrain.</p>`;
  }
  const base = sweep.baseline && sweep.baseline.summary;
  const verdict = m.skill === null || m.skill === undefined
    ? 'No run had a usable baseline, so there is no skill figure.'
    : m.skill > 0
      ? `Across every scored point, the forecast's total error was ${formatPct(m.skill, 1)} smaller than assuming the price stays flat.`
      : m.skill === 0
        ? 'The forecast currently matches assuming the price stays flat: for most items it found no shape that beat a flat line on their own history, so it draws one.'
        : `The forecast is currently <b>worse than assuming the price stays flat</b> – its total error was ${formatPct(-m.skill, 1)} larger. Treat the prediction line as unproven.`;
  const skipped = (m.skipped || []).map((s) => `${formatInt(s.count)} ${esc(s.code)}`).join(', ');
  const worst = (sweep.byItem || []).filter((r) => r.skill !== null).sort((a, b) => a.skill - b.skill).slice(0, 5);
  return `
    <div class="grid grid-4">
      ${stat('Skill vs flat price', formatPctSigned(m.skill, 1), signClass(m.skill), `median ${formatPctSigned(m.medianSkill, 1)}`)}
      ${base ? stat('Previous model (pred-7)', formatPctSigned(base.skill, 1), signClass(base.skill), 'same windows, own-history model alone') : ''}
      ${stat('Direction right', formatPct(m.directionalAccuracy, 0), '', 'share of points where the forecast got the move\'s sign right')}
      ${stat('Simulated trades', formatInt(m.trades), '', m.winRate === null || m.winRate === undefined ? 'no trades taken' : `${formatPct(m.winRate, 0)} won`)}
      ${stat('Runs scored', formatInt(m.scored), '', skipped ? `skipped: ${skipped}` : `${formatInt(sweep.items)} items × ${formatInt(sweep.starts)} start points`)}
    </div>
    <p style="margin:0.9rem 0 0;max-width:78ch">${verdict}</p>
    ${worst.length ? `<p class="dimmer" style="font-size:0.75rem;margin:0.5rem 0 0">Weakest items: ${worst.map((r) => `<a href="${itemHref(r.item)}">${esc(itemLabel(r.item))}</a> ${formatPctSigned(r.skill, 0)}`).join(' · ')}.</p>` : ''}
    <p class="dimmer" style="font-size:0.75rem;margin:0.5rem 0 0">
      Model ${esc(sweep.modelVersion || '–')}, ${esc(sweep.range)} horizon of ${esc(formatDuration(sweep.futureMs))},
      only forecasts made after its training data ends, start points from ${esc(formatLocalTime(sweep.window && sweep.window.from))} to ${esc(formatLocalTime(sweep.window && sweep.window.to))}.
      Run <span data-age="${sweep.computedAt}">${esc(formatAge(sweep.computedAt, now))}</span>.
    </p>`;
}

function spreadCard(spread, now) {
  if (!spread) {
    return '<p class="dim" style="margin:0">No spread hit-rate check has run yet. The worker runs one daily.</p>';
  }
  const below = spread.hitRate !== null && spread.hitRate < spread.bar;
  return `
    <div class="grid grid-3">
      ${stat('Spread hit rate', formatPct(spread.hitRate, 0), spread.hitRate === null ? '' : below ? 'neg' : 'pos', `bar is ${formatPct(spread.bar, 0)}`)}
      ${stat('Signals checked', formatInt(spread.evaluated), '', `${formatInt(spread.hits)} still held, ${formatInt(spread.misses)} gone`)}
      ${stat('Hours sampled', formatInt((spread.samples || []).filter((x) => x.ok).length), '', `of ${formatInt((spread.samples || []).length)} attempted`)}
    </div>
    <p style="margin:0.9rem 0 0;max-width:78ch">${spread.hitRate === null
    ? 'No sample had both snapshots it needed, so there is no hit rate yet.'
    : below
      ? '<b>Below the bar.</b> Fewer than half of the top spread signals still cleared tax an hour later, which means spread scoring is ranking spreads that do not last.'
      : 'Most of the top spread signals still cleared tax an hour after they were scored.'}</p>
    <p class="dimmer" style="font-size:0.75rem;margin:0.5rem 0 0">
      For each sampled hour: the top 20 spread signals at that moment, re-checked one hour later.
      Run <span data-age="${spread.computedAt}">${esc(formatAge(spread.computedAt, now))}</span>.
    </p>`;
}

function fitsCard(fits, now) {
  if (!fits) {
    return '<p class="dim" style="margin:0">Event magnitudes have not been fitted yet. Until they are, every event effect is a conservative placeholder and says so.</p>';
  }
  const rows = fits.entries.map((e) => `
    <tr>
      <td>${esc(itemLabel(e.event))}</td>
      <td>${esc(itemLabel(e.group))}</td>
      <td class="num ${signClass(e.magnitude)}">${formatPctSigned(e.magnitude, 1)}</td>
      <td class="num">${formatInt(e.samples)}</td>
      <td class="num">${formatInt(e.items)}</td>
      <td>${e.fitted ? 'fitted' : '<span class="dimmer">too few windows – placeholder still used</span>'}</td>
    </tr>`).join('');
  return `
    <p style="margin:0 0 0.9rem;max-width:78ch">
      ${formatInt(fits.fitted)} of ${formatInt(fits.measured)} event-and-item-group effects are fitted from stored history.
      The rest still use the registry's placeholder magnitudes until enough past windows exist.
    </p>
    ${rows ? `<div class="table-wrap"><div class="table-scroll"><table class="ledger">
      <thead><tr><th>Event</th><th>Group</th><th class="num">Measured effect</th><th class="num">Windows</th><th class="num">Items</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>` : ''}
    <p class="dimmer" style="font-size:0.75rem;margin:0.5rem 0 0">
      Fitted <span data-age="${fits.computedAt}">${esc(formatAge(fits.computedAt, now))}</span>. Mayor-perk events need terms recorded
      by the election feed, so they fit as terms accumulate.
    </p>`;
}

function modelSection(model, now) {
  if (!model) {
    return '<div class="card"><p class="dim" style="margin:0">The model report could not be loaded.</p></div>';
  }
  return `
    <div class="card">
      <span class="label" style="display:block;margin-bottom:0.9rem">Prediction backtest</span>
      ${sweepCard(model.sweep, now)}
    </div>
    <div class="card" style="margin-top:1rem">
      <span class="label" style="display:block;margin-bottom:0.9rem">Spread signals</span>
      ${spreadCard(model.spreadHitRate, now)}
    </div>
    <div class="card" style="margin-top:1rem">
      <span class="label" style="display:block;margin-bottom:0.9rem">Event effects</span>
      ${fitsCard(model.eventFits, now)}
    </div>`;
}

function render(health, version, snap, model) {
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
        ${stat('Raw ticks', health.rows ? formatCompact(health.rows.raw) : 'not counted yet')}
        ${stat('Hourly bars', health.rows ? formatCompact(health.rows.barsHourly) : 'not counted yet', '', `oldest ${esc(formatLocalTime(health.oldestBar.hourly))}`)}
        ${stat('Five-minute bars', health.rows ? formatCompact(health.rows.barsFiveMin) : 'not counted yet', '', `oldest ${esc(formatLocalTime(health.oldestBar.fiveMin))}`)}
      </div>
      <p class="dimmer" style="font-size:0.75rem;margin:0.6rem 0 0">
        ${health.rows
    ? `Counted <span data-age="${health.rows.countedAt}">${esc(formatAge(health.rows.countedAt, now))}</span> by the worker's daily job.`
    : 'The worker counts these once a day; no count has been taken since this build was deployed.'}
        Counts are <span class="mono">COUNT(*)</span> scans, so they are taken once a day and stored
        rather than run on every visit. Five-minute bars cover every product and are kept for 14
        days; hourly bars are kept indefinitely. The oldest-bar times are always live.
      </p>
      <p class="dim" style="font-size:0.82rem;margin:1rem 0 0">
        A range can only be charted or predicted as far back as the bars behind it reach. There are
        ${esc(formatDuration(now - health.oldestBar.hourly))} of hourly bars, so asking for six
        months charts the part that exists against the real six-month axis and leaves the rest of
        the window blank – it is not stretched to fill the range, and it is not a failure of the
        page. Prediction is the stricter case: a horizon the bars cannot support returns
        <span class="mono">INSUFFICIENT_HISTORY</span> rather than extrapolating.
      </p>
    </div>

    <h2 class="section-heading">Model check</h2>
    ${modelSection(model, now)}

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
  callWorker('/health'),
  callWorker('/version').catch(() => null),
  loadSnapshot().catch(() => null),
  callWorker('/model').catch(() => null),
]).then(([healthRes, versionRes, snap, modelRes]) => {
  if (healthRes.status !== 200) {
    renderErrorState(body, classifyFailure(null, healthRes.body) || 'unknown', { what: 'Worker health' });
    return;
  }
  const version = versionRes && versionRes.status === 200 ? versionRes.body : null;
  const model = modelRes && modelRes.status === 200 ? modelRes.body : null;
  render(healthRes.body, version, snap, model);
  // Every relative time above carries data-age, so the shared ticker keeps it live (CLAUDE.md rule 12).
  startAgeTicker(body);
}).catch(() => {
  renderErrorState(body, 'unreachable');
});
