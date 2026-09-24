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
- `migrations/` — SQL migrations (`node run_migrations.js`)
- `public/` — static frontend assets served by the API (if present)

## Env vars (see `.env.example`)

- `PORT`, `DATABASE_URL`, `JWT_SECRET`, `ADMIN_SETUP_KEY`
