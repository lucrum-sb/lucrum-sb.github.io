# Lucrum – web

Bazaar intelligence for Hypixel SkyBlock. The static site, served by GitHub Pages at
<https://lucrum-sb.github.io/>.

This directory is the source of truth. `.github/workflows/deploy-web.yml` in
[`lucrum-sb/lucrum`](https://github.com/lucrum-sb/lucrum) mirrors it onto `main` of
`lucrum-sb/lucrum-sb.github.io` on every push under `web/`, with a force-push, so anything
committed directly to the Pages repo is overwritten on the next mirror. Edit here, not there.

- No build step: files are published as-is (`.nojekyll` stops GitHub Pages running Jekyll).
- Pages setting on the Pages repo: Deploy from a branch, `main`, `/ (root)`.
- The site reads the worker at `https://lucrum.lancus.workers.dev` (`js/api.js`; override with
  `window.LUCRUM_WORKER_ORIGIN` for local dev). The worker's `WEB_ORIGIN` must stay
  `https://lucrum-sb.github.io` or credentialed calls fail CORS.
- Visual identity: `docs/BRAND.md`. Endpoint shapes: `docs/CONTRACTS.md`.
