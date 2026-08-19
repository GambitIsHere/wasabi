# Running Wasabi locally

**Three commands and it's up — fully offline, no cloud, no Google sign-in:**

```bash
docker compose -f docker-compose.dev.yml up -d     # 1. start Postgres + the proxy
cp .env.local.example .env.local                    # 2. env (then add a secret, below)
echo "AUTH_SECRET=$(openssl rand -base64 32)" >> .env.local
npm run dev                                          # 3. app on http://localhost:3000
```

Open `http://localhost:3000`, and the create → activate → assign → verdict loop runs against a Postgres box on your machine. Stop with `docker compose -f docker-compose.dev.yml down` (keeps your data).

---

## Why it takes a proxy

Prod runs on **Vercel + Neon**, so the app talks to Postgres through **`@neondatabase/serverless`** — Neon's HTTP driver, which is right for serverless but can't speak to a plain local Postgres. So local dev puts a small **Neon-protocol proxy** in front of a Postgres container:

```
your app (npm run dev)  ──http──►  neon-proxy  ──tcp──►  postgres
   localhost:3000                   :4444                 :5432
```

`docker-compose.dev.yml` runs the two boxes; the app runs on the host via `npm run dev` so you keep hot-reload. Same architecture as prod, mirrored locally.

## What makes it work — three env flags

Set in `.env.local` (gitignored). All are **dev-only and default off**, so prod behaviour is untouched:

| Flag | Effect |
|---|---|
| `USE_LOCAL_PG=1` | `lib/db.ts` points the Neon driver at the local proxy instead of Neon cloud |
| `NEON_LOCAL_PROXY=http://localhost:4444/sql` | where the proxy listens |
| `WASABI_DEV_NO_AUTH=1` | `middleware.ts` skips the Google-SSO gate so you can reach the admin locally |

`AUTH_SECRET` is still required (Auth.js initializes even when the gate is bypassed) — generate one with `openssl rand -base64 32`.

## Ports

| Port | What |
|---|---|
| 3000 | the app (`npm run dev`) |
| 5432 | Postgres |
| 4444 | Neon proxy |

## Everyday commands

```bash
docker compose -f docker-compose.dev.yml up -d      # start the DB + proxy
docker compose -f docker-compose.dev.yml ps         # check they're healthy
docker compose -f docker-compose.dev.yml logs -f    # watch them
docker compose -f docker-compose.dev.yml down       # stop, keep data
docker compose -f docker-compose.dev.yml down -v     # stop, WIPE the DB (fresh seed next start)
psql postgresql://wasabi:wasabi@localhost:5432/wasabi   # poke the DB directly (if psql installed)
```

The schema is created and seeded automatically on first query (`lib/db.ts` → `createSchema`, `lib/store.ts` → seed), so a fresh volume just works.

## Troubleshooting

- **`ECONNREFUSED` / results empty on first load** — the proxy or Postgres isn't up yet. `docker compose -f docker-compose.dev.yml ps` should show both, Postgres `healthy`. Give it a few seconds after `up`.
- **Port already in use (5432 / 4444)** — something else is bound. Stop it, or change the host-side port in `docker-compose.dev.yml` (and `NEON_LOCAL_PROXY` / `DATABASE_URL` to match).
- **Redirected to `/signin`** — `WASABI_DEV_NO_AUTH=1` isn't in `.env.local`, or the dev server didn't pick it up (restart `npm run dev` after editing env).
- **Want a clean slate** — `down -v` drops the volume; the next `up` + first request re-seeds.

## Safety

The two code branches (`lib/db.ts`, `middleware.ts`) are guarded by env flags that are **absent in every deployed environment**. On Vercel there is no `USE_LOCAL_PG` and no `WASABI_DEV_NO_AUTH`, so the app uses Neon cloud and enforces Google SSO exactly as before. Never set these flags in a deployment.
