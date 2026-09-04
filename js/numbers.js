// Ledger-style number reveal – docs/BRAND.md's motion rules: a number counts up once on
// load/update, ease-out, ~400ms, from the previous known value (never from zero, which would
// misrepresent the figure as new). No fake data is fed through this in the current shell/link
// pages – it's built now so Phase 8's signal browser and portfolio pages (the pages that actually
// have live figures to reveal) don't reinvent it.
export function countUp(el, from, to, opts = {}) {
  const duration = opts.duration ?? 400;
  const format = opts.format ?? ((n) => n.toFixed(opts.decimals ?? 0));
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = format(to);
    return;
  }
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic, per docs/BRAND.md
    el.textContent = format(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
