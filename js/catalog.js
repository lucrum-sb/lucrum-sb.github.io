// The product catalogue – every bazaar item the worker knows about, from GET /snapshot.
//
// This exists because the site's worst navigational failure was that /snapshot's ~2000 products
// were never exposed anywhere: the only way to reach an item page was to click a signal row. The
// palette in js/shell.js and the market table both read from here.
//
// No market logic (CLAUDE.md hard rule 2): this fetches, caches and does substring matching on
// ids. It never computes a price, a rank or a score.
import { callWorker } from './api.js';

const ID_CACHE_KEY = 'lucrum-item-ids';
const ID_CACHE_TTL = 10 * 60 * 1000;

let snapshotPromise = null;

/** The full snapshot, memoised for the lifetime of the page. ~600 KB over the wire (compressed by
 * Cloudflare), so it is fetched once per page and shared by every caller. */
export function loadSnapshot() {
  if (!snapshotPromise) {
    snapshotPromise = callWorker('/snapshot').then((res) => {
      if (res.status !== 200) {
        snapshotPromise = null; // don't cache a failure – a reload should retry
        const err = new Error('snapshot failed');
        err.body = res.body;
        throw err;
      }
      cacheIds(Object.keys(res.body.products || {}));
      return res.body;
    }, (err) => {
      snapshotPromise = null;
      throw err;
    });
  }
  return snapshotPromise;
}

function cacheIds(ids) {
  try {
    sessionStorage.setItem(ID_CACHE_KEY, JSON.stringify({ at: Date.now(), ids }));
  } catch (err) {
    // sessionStorage unavailable or full – the palette just refetches next page load.
  }
}

function cachedIds() {
  try {
    const raw = sessionStorage.getItem(ID_CACHE_KEY);
    if (!raw) return null;
    const { at, ids } = JSON.parse(raw);
    if (!Array.isArray(ids) || Date.now() - at > ID_CACHE_TTL) return null;
    return ids;
  } catch (err) {
    return null;
  }
}

/** Just the ids, for the search palette. Served from sessionStorage across page navigations so
 * opening the palette on a fresh page doesn't cost a 600 KB download. */
export async function loadItemIds() {
  const cached = cachedIds();
  if (cached) return cached;
  const snap = await loadSnapshot();
  return Object.keys(snap.products || {});
}

/** Normalises what a person types ("enchanted diamond", "ENCH_DIA") towards the id shape. */
function normalise(q) {
  return q.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

/** Ranks ids against a query: exact, prefix, word-start, substring, then subsequence. Ties break
 * on the shorter id, which is almost always the base item rather than a variant. */
export function searchItems(ids, query, limit = 40) {
  const q = normalise(query);
  if (!q) return ids.slice(0, limit);
  const out = [];
  for (const id of ids) {
    let rank;
    if (id === q) rank = 0;
    else if (id.startsWith(q)) rank = 1;
    else if (id.includes(`_${q}`)) rank = 2;
    else if (id.includes(q)) rank = 3;
    else if (isSubsequence(q, id)) rank = 4;
    else continue;
    out.push({ id, rank });
  }
  out.sort((a, b) => a.rank - b.rank || a.id.length - b.id.length || (a.id < b.id ? -1 : 1));
  return out.slice(0, limit).map((r) => r.id);
}

function isSubsequence(needle, hay) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j += 1) {
    if (hay[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}
