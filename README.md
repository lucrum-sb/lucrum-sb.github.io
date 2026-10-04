# Lucrum – web

Static front end for Lucrum (bazaar intelligence for Hypixel SkyBlock), served by GitHub Pages at
<https://lucrum-sb.github.io/>. This repo is a mirror of the main project's `web/` directory; the
files at the repo root are published as-is (see `.nojekyll`), with no build step.

## Deployment

GitHub Pages: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**.

The site talks to the Cloudflare Worker at `https://lucrum.lancus.workers.dev` (override with
`window.LUCRUM_WORKER_ORIGIN`, see `js/api.js`). The worker's `WEB_ORIGIN` CORS setting must stay
`https://lucrum-sb.github.io`.

## Cloudflare plan

The project is now on a **paid Cloudflare Workers plan**, so the free-plan limits no longer apply:
CPU time limits per request, subrequest counts and D1 row-read budgets can all be raised. Raise the
CPU limit in the worker's `wrangler.toml` (`[limits] cpu_ms = ...`) rather than designing around
the old free-tier ceilings.

Some code here was written under free-plan constraints – e.g. the opt-in "Count stored rows" button
on the status page (`js/status.js`), which exists because `COUNT(*)` scans exhausted the free D1
daily row-read budget. It can be revisited now that the budget is much larger.
