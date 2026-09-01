# Running Wasabi locally

**Up and running, fully offline, no cloud, no Google sign-in:**

```bash
docker compose -f docker-compose.dev.yml up -d     # 1. start Postgres + the proxy
cp .env.local.example .env.local                    # 2. env (then add a secret, below)
echo "AUTH_SECRET=$(openssl rand -base64 32)" >> .env.local
set -a && source .env.local && set +a               # 3. one-time: tenancy columns need it —
npm run migrate:tenancy                              #    see scripts/migrate-tenancy.ts
npm run dev                                          # 4. app on http://localhost:3000
```

Open `http://localhost:3000`, and the create → activate → assign → verdict loop runs against a Postgres box on your machine. Stop with `docker compose -f docker-compose.dev.yml down` (keeps your data).

Step 3 is one-time per Postgres volume (safe to re-run — it's idempotent). Skip it and every page 500s with `column "project_id" does not exist`: the app code assumes the tenancy columns (`scripts/migrate-tenancy.ts`) exist, but — unlike the base tables — they're never created automatically (see that script's header for why). `set -a && source .env.local && set +a` is needed because `npm run migrate:tenancy` runs plain `node`, not `next dev`, so `.env.local` isn't auto-loaded the way it is for the app itself.

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

## Multi-tenant subdomains (Batch D-a)

Optimiser.Pro resolves the org from the request's `Host` header (`lib/subdomain.ts`) — in production that's `<org-slug>.optimiser.pro`. Locally you have three options, in the order `lib/subdomain.ts` checks them:

| What you do | What you get | Notes |
|---|---|---|
| `http://localhost:3000` (nothing else) | org `sanjow` | Zero-config default — only active when `USE_LOCAL_PG=1` (i.e. never on a real deployment). |
| `http://localhost:3000/?org=acme` | org `acme` | Dev-only query override, for testing a second org locally. Also gated on `USE_LOCAL_PG=1`. |
| `http://sanjow.localhost:3000` | org `sanjow` | Mirrors the production `<slug>.optimiser.pro` pattern exactly. Modern browsers resolve any `*.localhost` hostname to loopback with no `/etc/hosts` edit needed. Works the same whether or not `USE_LOCAL_PG=1` is set. |

Whichever you use, the org must actually exist in the `organization` table (seeded by `npm run migrate:tenancy` for `sanjow` — see above) or you'll see the "Unknown workspace" page instead of the app. `?org=` and the bare-`localhost` default are deliberately inert on any real host (`wasabi.sanjow-hub.com`, `*.optimiser.pro`) — an unknown subdomain there never falls back to Sanjow; see `lib/subdomain.ts`'s header comment.

Test password self-registration (`/register`) against `AUTH_ALLOWED_EMAIL_DOMAIN`/the `sanjow` org's `verified_domain` (`sanjow.com` by default) — a registered account lands as `status = 'pending'` and needs approval at `/admin/members` (only reachable by an `owner`/`admin` — the first Google sign-in to a fresh org becomes `owner` automatically) before it can sign in. `WASABI_DEV_NO_AUTH=1` bypasses the SSO gate entirely, so to actually exercise sign-in/registration locally, comment it out of `.env.local` and restart `npm run dev`.

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

Most of the schema is created and seeded automatically on first query (`lib/db.ts` → `createSchema`, `lib/store.ts` → seed), so a fresh volume mostly just works — the exception is the tenancy columns (`org_id` / `project_id` on `experiment`, `archived_experiment`, `event`, `metric`, `roadmap_test`), which need the one-time `npm run migrate:tenancy` from step 3 above. See `scripts/migrate-tenancy.ts`'s header for why those specifically aren't automatic.

## Troubleshooting

- **`ECONNREFUSED` / results empty on first load** — the proxy or Postgres isn't up yet. `docker compose -f docker-compose.dev.yml ps` should show both, Postgres `healthy`. Give it a few seconds after `up`.
- **Port already in use (5432 / 4444)** — something else is bound. Stop it, or change the host-side port in `docker-compose.dev.yml` (and `NEON_LOCAL_PROXY` / `DATABASE_URL` to match).
- **Redirected to `/signin`** — `WASABI_DEV_NO_AUTH=1` isn't in `.env.local`, or the dev server didn't pick it up (restart `npm run dev` after editing env).
- **Every page errors with `column "project_id" does not exist` (or `"org_id"`)** — the tenancy migration hasn't run against this volume yet: `set -a && source .env.local && set +a && npm run migrate:tenancy`, then restart `npm run dev`. If you edited `lib/*.ts` while `npm run dev` was already running and it hit this error, restart the dev server even after migrating — the schema-readiness check memoises its result in memory for the life of the process, so the first (pre-migration) failure otherwise stays cached until restart.
- **Want a clean slate** — `down -v` drops the volume; the next `up` needs `npm run migrate:tenancy` again (see step 3) before the first request.
- **"Unknown workspace" page instead of the app** — the Host you're using didn't resolve to a real org (see the "Multi-tenant subdomains" section above). Bare `localhost` and `?org=` only work when `USE_LOCAL_PG=1` is set; otherwise use `sanjow.localhost:3000`, or check the org you named actually exists in the `organization` table.

## Safety

The two code branches (`lib/db.ts`, `middleware.ts`) are guarded by env flags that are **absent in every deployed environment**. On Vercel there is no `USE_LOCAL_PG` and no `WASABI_DEV_NO_AUTH`, so the app uses Neon cloud and enforces Google SSO exactly as before. Never set these flags in a deployment.
