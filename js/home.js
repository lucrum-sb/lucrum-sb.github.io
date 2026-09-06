// Overview – the first screen. Real state only: the best-scoring signal the worker currently has,
// the rest of the leaderboard, the busiest products, and where to go next. No marketing copy
// standing in for data (docs/BRAND.md's copy register).
import { callWorker } from './api.js';
import { classifyFailure, failureText } from './errors.js';
import { loadSnapshot } from './catalog.js';
import { mountStatusStrip, itemHref, startAgeTicker } from './shell.js';
import {
  formatCoins, formatCompact, formatInt, formatPct, formatPctSigned, formatAge,
  formatFillMinutes, formatHoldDays, methodLabel, itemLabel, esc, signClass,
} from './format.js';

const TYPES = ['position', 'spread', 'craft', 'event'];
const heroSlot = document.getElementById('hero-slot');
const topSlot = document.getElementById('top-slot');
const moversSlot = document.getElementById('movers-slot');
const summarySlot = document.getElementById('market-summary');

const strip = mountStatusStrip(document.getElementById('status-strip'));

/* --- Signals ---------------------------------------------------------------------------------- */

async function loadSignals() {
  const out = { all: [], meta: null, failures: {} };
  await Promise.all(TYPES.map(async (type) => {
    try {
      const { status, body } = await callWorker(`/signals?type=${type}&limit=10`);
      if (status === 200) {
        out.all.push(...(body.signals || []));
        if (!out.meta || body.generatedAt > out.meta.generatedAt) out.meta = body;
      } else {
        out.failures[type] = classifyFailure(null, body) || 'unknown';
      }
    } catch (err) {
      out.failures[type] = 'unreachable';
    }
  }));
  out.all.sort((a, b) => b.score - a.score);
  return out;
}

function renderHero(best) {
  if (!best) {
    heroSlot.innerHTML = `<p class="empty-state">${esc(failureText('upstream_unavailable', { what: 'Signal scoring' }))}</p>`;
    return;
  }
  heroSlot.innerHTML = `
    <section class="hero-signal">
      <div class="hero-top">
        <div>
          <span class="label">Best scoring right now</span>
          <h2 style="margin-top:0.25rem"><a href="${itemHref(best.item)}">${esc(itemLabel(best.item))}</a></h2>
          <span class="hero-item-id">${esc(best.item)}</span>
        </div>
        <div class="tabs">
          <span class="type-badge">${esc(best.type)}</span>
          ${best.direction ? `<span class="type-badge ${esc(best.direction)}">${esc(best.direction)}</span>` : ''}
        </div>
      </div>
      <p class="thesis">${esc(best.thesis || best.why)}</p>
      <div class="hero-figures">
        <div class="stat"><span class="label">Score</span><span class="value lg accent">${best.score.toFixed(2)}</span></div>
        <div class="stat"><span class="label">Net / unit</span><span class="value lg ${signClass(best.netPerUnit)}">${formatCoins(best.netPerUnit)}</span></div>
        <div class="stat"><span class="label">Margin</span><span class="value lg ${signClass(best.marginPct)}">${formatPctSigned(best.marginPct)}</span></div>
        <div class="stat"><span class="label">Entry</span><span class="value buy-c">${formatCoins(best.entry.price)}</span><p class="note">${esc(methodLabel(best.entry.method))} · ${esc(formatFillMinutes(best.entry.estFillMinutes))}</p></div>
        <div class="stat"><span class="label">Exit</span><span class="value sell-c">${formatCoins(best.exit.price)}</span><p class="note">${esc(methodLabel(best.exit.method))} · ${esc(formatFillMinutes(best.exit.estFillMinutes))}</p></div>
        <div class="stat"><span class="label">${best.holdDays ? 'Hold' : 'Suggested qty'}</span><span class="value">${best.holdDays ? esc(formatHoldDays(best.holdDays)) : formatInt(best.suggestedQty)}</span></div>
      </div>
    </section>`;
}

function renderTop(signals, failures) {
  const rows = signals.slice(1, 8);
  const failed = Object.keys(failures);
  const note = failed.length
    ? `<p class="dimmer" style="font-size:0.75rem;margin-top:0.6rem">No completed pass for ${
      esc(failed.join(', '))
    } yet – those types are omitted rather than shown as empty.</p>`
    : '';
  if (!rows.length) {
    topSlot.innerHTML = `<p class="empty-state">Nothing else clears the scoring threshold right now.</p>${note}`;
    return;
  }
  topSlot.innerHTML = `
    <div class="table-wrap"><div class="table-scroll"><table class="ledger">
      <thead><tr>
        <th>Item</th><th>Type</th><th class="num">Net / unit</th>
        <th class="num">Margin</th><th class="num">Score</th>
      </tr></thead>
      <tbody>${rows.map((s) => `
        <tr>
          <td class="key"><a href="${itemHref(s.item)}">${esc(itemLabel(s.item))}</a>
            <span class="why-line">${esc(s.why)}</span></td>
          <td>${esc(s.type)}</td>
          <td class="num ${signClass(s.netPerUnit)}">${formatCoins(s.netPerUnit)}</td>
          <td class="num ${signClass(s.marginPct)}">${formatPctSigned(s.marginPct)}</td>
          <td class="num">${s.score.toFixed(2)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div></div>
    <p style="margin-top:0.6rem"><a href="signals/">All signals &rarr;</a></p>
    ${note}`;
}

/* --- Market ------------------------------------------------------------------------------------ */

function renderMarket(snap) {
  const products = snap.products || {};
  const ids = Object.keys(products);
  strip.update({ taxRate: snap.taxRate, mayor: snap.mayor });

  const movers = ids
    .map((id) => ({ id, ...products[id] }))
    .sort((a, b) => (b.sellMovingWeek || 0) - (a.sellMovingWeek || 0))
    .slice(0, 8);

  moversSlot.innerHTML = `
    <div class="table-wrap"><div class="table-scroll"><table class="ledger">
      <thead><tr>
        <th>Item</th><th class="num">Instant buy</th><th class="num">Instant sell</th>
        <th class="num">Spread %</th><th class="num">Sold / week</th>
      </tr></thead>
      <tbody>${movers.map((p) => `
        <tr>
          <td class="key"><a href="${itemHref(p.id)}">${esc(itemLabel(p.id))}</a>
            <span class="why-line">${esc(p.id)}</span></td>
          <td class="num buy-c">${formatCoins(p.instantBuy)}</td>
          <td class="num sell-c">${formatCoins(p.instantSell)}</td>
          <td class="num ${signClass(p.spreadPct)}">${formatPctSigned(p.spreadPct, 2)}</td>
          <td class="num">${formatCompact(p.sellMovingWeek)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div></div>
    <p style="margin-top:0.6rem"><a href="market/">Browse all ${formatInt(ids.length)} products &rarr;</a></p>`;

  const mayorName = snap.mayor && snap.mayor.name ? snap.mayor.name : null;
  summarySlot.innerHTML = `
    <div class="grid grid-3">
      <div class="stat"><span class="label">Products</span><span class="value">${formatInt(ids.length)}</span></div>
      <div class="stat"><span class="label">Bazaar tax</span><span class="value">${formatPct(snap.taxRate, 2)}</span></div>
      <div class="stat"><span class="label">Snapshot</span><span class="value" data-age="${snap.lastUpdated || ''}">${esc(formatAge(snap.lastUpdated))}</span></div>
    </div>
    <p class="dim" style="font-size:0.82rem;margin:0.9rem 0 0">
      ${mayorName
    ? `Mayor <b>${esc(mayorName)}</b>${snap.mayor.minister && snap.mayor.minister.name ? `, minister ${esc(snap.mayor.minister.name)}` : ''}. Tax and event effects are resolved against this term.`
    : 'No mayor is recorded in the current snapshot, so tax and perks fall back to the base rate. The election feed is the source, not this page.'}
    </p>`;
}

/* --- Init --------------------------------------------------------------------------------------- */

loadSignals().then(({ all, meta, failures }) => {
  if (meta) strip.update({ taxRate: meta.taxRate, generatedAt: meta.generatedAt });
  renderHero(all[0]);
  renderTop(all, failures);
});

loadSnapshot().then((snap) => {
  renderMarket(snap);
  startAgeTicker(summarySlot);
}).catch(() => {
  moversSlot.innerHTML = `<p class="error-state">${esc(failureText('unreachable'))}</p>`;
  summarySlot.innerHTML = `<p class="dim" style="margin:0">${esc(failureText('unreachable'))}</p>`;
});
