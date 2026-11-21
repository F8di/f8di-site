# F8di Stats (`/stats`)

Private Roblox analytics dashboard. It runs as Cloudflare Pages Functions in this repo. It needs no build step and no npm dependencies, and it leaves the public page, view counter, `/contact` and `/shop` unchanged.

## How it is protected

- `functions/stats/_middleware.js` answers every `/stats/*` request. It never falls through to static files.
- One owner account, set by secrets. There is no registration. Sign-in needs the username, a password (PBKDF2-SHA256, 100k iterations) and a TOTP code. A TOTP code can't be reused.
- Sessions are random tokens. The database stores only their hashes. The cookie is `__Host-`, HttpOnly, Secure and SameSite=Strict. A session expires after 2 hours idle or 12 hours total. With "Stay signed in" ticked it lasts 7 days idle or 30 days total. Settings has a "Sign out everywhere" button.
- Failed sign-ins are limited to 5 per IP per 15 minutes and 25 per hour across all IPs.
- State-changing API calls need a per-session CSRF token plus a same-origin check. The sign-in form uses a double-submit token.
- Responses send `no-store`, `noindex`, a strict CSP (no inline scripts, no third-party scripts or fonts), `frame-ancestors 'none'` and HSTS.
- Exports, reports and all API routes use the same session check. The telemetry ingest endpoint takes a per-experience bearer token, stored hashed. The cron endpoint takes `STATS_CRON_TOKEN`.
- Function source and `ops/` return 404 instead of being served as static files.
- If any required secret or the database is missing, `/stats` returns a plain 503 and stays closed.

## Setup (production)

1. **Create the database.** Cloudflare dashboard > Storage & Databases > D1 > Create, for example `f8di-stats`. The schema is created on first request (`functions/_lib/schema.js`).
2. **Bind it.** Pages project > Settings > Bindings > add D1 database, variable name `STATS_DB`. Add it for Production and also for Preview if you want branch previews to work.
3. **Create the credentials.** Run `node ops/stats-setup.mjs` locally. It asks for a username and password and prints:
   - `STATS_OWNER`, `STATS_PASSWORD_HASH`, `STATS_TOTP_SECRET`, `STATS_SESSION_SECRET`, `STATS_CRON_TOKEN`

   Add each one under Pages > Settings > Variables and Secrets as type **Secret**. Add the TOTP secret to your authenticator app.
4. **Optional secrets:**
   - `STATS_ALERT_WEBHOOK_URL`: a private Discord webhook for alerts. It is separate from the public contact webhook.
   - `ROBLOX_OPEN_CLOUD_KEY`: an Open Cloud API key with read-only universe access for your own experiences.
   - `ROBLOX_OAUTH_CLIENT_ID` and `ROBLOX_OAUTH_CLIENT_SECRET` (optional): enable **Settings → Connect Roblox account**. Create an OAuth 2.0 app at https://create.roblox.com/dashboard/credentials?activeTab=OAuthTab with redirect URL `https://<your-site>/stats/roblox/callback` and permissions `openid`, `profile` and `universe.analytics:read`. Private apps work for up to 10 users without Roblox review. The dashboard then imports official Roblox Analytics metrics (DAU, MAU, D1/D7/D30 retention, session length, playtime, revenue, paying users, ARPPU, conversion, peak CCU) every 6 hours into `official_metrics`; tokens are AES-GCM encrypted with a key derived from `STATS_SESSION_SECRET` (rotating that secret disconnects the account). An Open Cloud key with `universe.analytics:read` is used as a fallback for the same import. `ROBLOX_OAUTH_SCOPES` overrides the requested scopes.
   - Workers AI binding named `AI`: adds a clearly labelled AI summary to reports. Without it, reports contain only the statistics.
   - Tuning: `STATS_DISCOVERY_CAP` (default 250), `STATS_TRACKED_INTERVAL_MIN` (15), `STATS_DISCOVERY_INTERVAL_MIN` (30), `STATS_ITEM_INTERVAL_MIN` (60), `STATS_SNAPSHOT_RETENTION_DAYS` (90).
5. **Schedule collection.** Pages Functions have no cron triggers, so `.github/workflows/stats-collect.yml` calls `POST /stats/api/cron` every 15 minutes. Add two repository secrets under GitHub > Settings > Secrets and variables > Actions:
   - `STATS_SITE_URL`: for example `https://f8di.com`
   - `STATS_CRON_TOKEN`: the same value as the Pages secret

   Until both are set, the workflow skips. Collection then runs only while the dashboard is open.
6. Redeploy, then open `/stats`.

## Local development

```
cat > .dev.vars <<'VARS'   # untracked
STATS_OWNER=...
STATS_PASSWORD_HASH='pbkdf2-sha256$100000$...'   # single quotes: the value contains $
STATS_TOTP_SECRET=...
STATS_SESSION_SECRET=...
STATS_CRON_TOKEN=...
VARS
wrangler pages dev . --port 8788 --compatibility-date=2024-09-23 --d1 STATS_DB=f8di-stats-local
```

## Data sources and limits

- Games come from `games.roblox.com/v1/games` (players, visits, favorites, genre, creator, dates) and `/v1/games/votes` (likes and dislikes). New games are discovered through Roblox's public explore sorts (`apis.roblox.com/explore-api`). Search uses `apis.roblox.com/search-api/omni-search`.
- Tracked games get a raw snapshot every 15 minutes. Discovered games, up to the cap, get hourly aggregates every 30 minutes. Daily rollups are kept indefinitely. Hourly data is kept for 21 days and raw snapshots for 90 days.
- Collectibles come from catalog item details (lowest resale price, sampled hourly) and `economy.roblox.com/.../resale-data` (RAP, sales, price points). Roblox's resale feed can lag, so the dashboard shows the date of its latest point. Purchases and trades are never automated.
- Private experience metrics (DAU, retention, sessions, revenue, products, game passes, errors, performance, custom events, economy) come only from telemetry that your own experience sends to `/stats/ingest`. My Experiences generates the Luau module for it. Player ids are pseudonymised before they are stored.
- On the D1 free tier (100k rows written per day), the defaults use about 40k writes per day. Raise `STATS_DISCOVERY_CAP` only on a paid plan.
