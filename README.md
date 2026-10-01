# KAALA MITHRA — Backend API

Express + PostgreSQL backend for the KAALA MITHRA app (`kaalamithra-app`).

## Quick start

```bash
npm install
copy .env.example .env   # then edit DATABASE_URL / JWT_SECRET
node run_migrations.js
node server.js
```

Server runs on `http://localhost:5000` by default.

## Main files

- `server.js` — Express app entrypoint
- `routes/` — `auth.js`, `admin.js`, `client.js`
- `middleware/auth.js` — JWT auth helpers
- `migrations/` — SQL migrations (`node run_migrations.js`); `lib/schema.js`
  applies the same additive DDL at runtime so hosted DBs heal themselves
- `public/` — static frontend assets served by the API (if present)

## Env vars (see `.env.example`)

- `PORT`, `DATABASE_URL`, `JWT_SECRET`, `ADMIN_SETUP_KEY`
- `FRONTEND_URL` (or `CORS_ORIGINS`) — deployed frontend origin(s) for CORS
- `NODE_ENV=production` on Vercel (enables SSL pool + Secure cookies)

## Run the full app locally (backend + logo frontend)

```bash
node run_app.js              # starts backend :5000 + frontend :5500 (detached, logs to run-*.log)
node scripts/check_running.js  # verify: /api/health + /welcome + app/index.html + km-logo.png all 200
```

- Backend API: `http://127.0.0.1:5000` (`/welcome`, `/login`, `/api/health`)
- Logo frontend (patched file, NOT in this repo):
  `C:\Users\Lenovo\Downloads\kaalamithra-complete (1)\kaalamithra-complete\app\index.html`
  served at `http://127.0.0.1:5500/kaalamithra-complete/app/`
  (`images/km-logo.png` = real logo; `backend/public/login.html` is only the K-box page).
- Local DB: `kaalamithra_db` (`users=24`, `inquiries=4` as of 2026-09-28;
  `admin@kaalamithra-ai.com` active). Vercel uses a separate hosted
  `DATABASE_URL`, so counts differ there by design.

## Deploying on Vercel (same repo serves API + pages)

1. `git push origin main` (includes `vercel.json`, `api/index.js`, `lib/`).
2. Vercel Dashboard → Project → Settings → Environment Variables
   (Production + Preview):
   - `DATABASE_URL` — **hosted** Postgres URL (Neon / Supabase / Vercel
     Postgres). Vercel cannot reach `localhost`, so the local
     `postgres://...@localhost:5432/...` value must NOT be reused.
   - `JWT_SECRET`, `ADMIN_SETUP_KEY`
   - `FRONTEND_URL=https://kaalamithra-app.vercel.app`
   - `NODE_ENV=production`
3. Create tables in the hosted DB — normally **not needed**: the app self-heals
   the schema on every cold start (see "Schema self-heal" below), so the
   Admin/Client dashboards work even if migrations were never applied. To do it
   explicitly:
   `DATABASE_URL=<hosted-url> node run_migrations.js`
   (or run the files in `migrations/` — `001`, `002`, `003` — in the provider SQL editor).
4. Redeploy, then verify:
   - `GET /api/health` → `{"success":true,"db":"connected",...,"schema_ready":true,"missing_columns":[]}`
     (`schema_ready:false` names the exact missing columns; until they exist the
     Admin Dashboard shows "Could not load submissions." while `/api/admin/me`
     and `/api/health` still return 200)
   - `GET /api/auth/me` → `401` (not a CORS error, not a 500)
   - Login works. If `/api/health` says `DATABASE_URL is not set`,
     the env var is missing on that deployment.

## Verification harness (run these after any change)

```bash
node scripts/launch_server.js        # detached backend on :5000 (survives the shell)
node scripts/probe_up.js             # waits until / answers, prints /api/health
node scripts/verify_access.js        # DB + pages + admin/client roles + must-deny cases
node scripts/verify_ui_flow.js       # cookie-session browser-style journeys (admin + client)
node scripts/verify_nodb.js          # boots with DATABASE_URL removed: no crash, clean errors
node scripts/verify_live.js          # read-only smoke test of the deployed app
node scripts/probe_live_root.js      # status/body of "/" on Vercel (homepage regression)
```

Both verify suites hit `127.0.0.1:5000` by default; point them at any other
running copy (a second clone of this repo, a preview build) with
`KM_HOST` / `KM_PORT`:

```bash
node server.js                       # in a fresh clone of this repo, on another port
set PORT=5055&& node server.js
set KM_PORT=5055&& node scripts/verify_access.js && set KM_PORT=5055&& node scripts/verify_ui_flow.js
```

- `verify_access.js` + `verify_ui_flow.js` create throwaway client users/inquiries with
  timestamped emails and delete them at the end (`CLEANUP removed ... baseline ...`).
- Row-level scoping is asserted explicitly: a client calling `GET /api/inquiries`
  gets **only** its own rows (matched by `user_id` or by its own `email`), while an
  admin gets all rows. Do not relax this without re-running the suite.

## Schema self-heal (why the dashboard can no longer 500 on schema drift)

The Admin Dashboard reads `inquiries.status`, `inquiries.nda_requested` and
`inquiries.user_id` (added by migrations `001` + `002`). A hosted database that
predates those migrations answers those SELECTs with `42703 undefined_column`,
which the UI showed as **"Could not load submissions."** — while
`/api/admin/me` and `/api/health` still returned 200, because they only touch
`users` / `count(*)`. That asymmetry is the fingerprint of this drift.

`lib/schema.js` applies the same additive DDL as migrations `001`–`003` on every
cold start: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS`, NULL-only backfills, indexes and an optional FK. Every read route
(`/api/admin/stats|submissions|submissions/:id|statuses|services`,
`/api/client/inquiries`, `/api/inquiries`) awaits it before querying, so no
request can race ahead of the fix on a serverless cold start. Nothing is ever
dropped, truncated, renamed or overwritten, and every statement is idempotent —
running it against an up-to-date database is a no-op.

`migrations/003_admin_read_columns.sql` is the same fix as a standalone SQL file
for psql / the Neon SQL editor, and `POST /api/setup` runs the heal too.

Confirm on production: `GET /api/health` → `schema_ready: true` and
`missing_columns: []`.

## Bootstrapping the hosted database (no psql needed)

After `DATABASE_URL` + `ADMIN_SETUP_KEY` exist on Vercel and the project was
redeployed:

```bash
node scripts/run_hosted_setup.js https://kaalamithra-app.vercel.app <ADMIN_SETUP_KEY>
```

It calls `POST /api/setup {"key": ...}` (applies `migrations/*.sql`, self-heals
`users.role/is_active`, seeds `admin@kaalamithra-ai.com`), then checks
`/api/health`, logs in as admin, and writes+reads one probe inquiry. Expected last
line: `HOSTED_DB_READY`. Change the seeded admin password right after the first login.

## Git remotes (identical content)

`main` is pushed to both GitHub remotes; keep them in sync so either one can be
cloned and run:

```bash
git remote add ashabv18 https://github.com/Ashabv18/kaalamithra-app.git   # one-time
git push origin main && git push ashabv18 main:main
```

Parity is proven by the commit/tree hash, not by eye:
`git rev-parse main` vs `git ls-remote --heads <remote>` must match.

`.gitattributes` pins text files to LF (`* text=auto eol=lf`, batch files stay
CRLF, images binary). Without it `core.autocrlf=true` rewrites text files to
CRLF on Windows checkout, so a fresh clone served responses a few bytes longer
than the reference workspace — whitespace-only, but enough to break byte-level
comparison of `/`, `/call.html` etc.

## Status verified on 2026-09-29

- Local (`kaalamithra_db`): `ALL_ACCESS_CHECKS_PASSED` + `UI_FLOW_PASSED`,
  baseline `inquiries=4 users=24`, `/` serves the logo app (135 KB).
- Fresh clone of `https://github.com/Ashabv18/kaalamithra-app.git` run on `:5055`
  (`KM_PORT=5055`): same `ALL_ACCESS_CHECKS_PASSED` + `UI_FLOW_PASSED` output and
  the same route statuses as `:5000` — the pushed code behaves exactly like
  localhost (needs `npm install` + a `.env` copied from `.env.example`).
- Live `https://kaalamithra-app.vercel.app`: `/`, `/app`, `/welcome`, `/login`,
  `/client/login`, `/admin/login` → `200`; `GET /api/inquiries` → `401`;
  `/api/health` + sign-in → clean `DATABASE_URL is not set ...` message.
  **Still blocked on:** setting `DATABASE_URL` + `ADMIN_SETUP_KEY` in the Vercel
  dashboard (Production), redeploying, then running the bootstrap above.

