# Deploy — Wasabi self-hosted

Runs the Wasabi dashboard (Next.js standalone) + a SQLite store behind Caddy, on your own box — same pattern as `n8n-stack` / `termix-stack`. No SaaS, no cloud DB, no per-seat cost.

## What you get
- `wasabi` — the app (admin UI + `/decide`/`/capture`/`/flags` API). SQLite store in a named volume.
- `caddy` — TLS + routing. **Admin UI behind basic-auth; `/api/decide` + `/api/capture` public** (storefronts call them).

## Deploy
```bash
cp .env.example .env            # fill in WASABI_DOMAIN, the Metabase key, etc.
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'YOURPASS'   # -> BASIC_AUTH_HASH
docker compose up -d --build
```
Point `WASABI_DOMAIN` at the host (or use `tailscale serve` and skip public DNS). Open it, log in, and the two seed experiments are there — create your own from the UI.

## The data
- The entire experiment store is the **`wasabi-data` volume** (`/app/.data/wasabi.db`). **Back it up** (e.g. `docker run --rm -v wasabi-data:/d -v $PWD:/b alpine cp /d/wasabi.db /b/`). It's the only stateful thing.
- Restart-safe: the volume persists across `docker compose up/down`.

## Point a storefront at it
1. Drop `integration/nextjs-middleware.example.ts` into the storefront as `middleware.ts`.
2. Set the experiment(s) + variant→`?theme=` map there (or call `https://$WASABI_DOMAIN/api/decide`).
3. The storefront's existing theme-resolver does the rest — no other change.
4. Turn that storefront's VWO campaign off. First real traffic on Wasabi.

## Security
- **Protect the admin UI** — basic-auth is the floor; prefer Tailscale/VPN. It can create/activate experiments.
- **`/api/decide` + `/api/capture` are intentionally public** (storefronts need them); they only assign/record, never expose data.
- **The Metabase key is read-only** and lives in `.env` on the host only — never in the repo, never in a browser.
- Run as non-root (the image already does).

## Notes
- `node:sqlite` ships with Node 24 (experimental, no flag). If your runtime gates it, add `NODE_OPTIONS=--experimental-sqlite` to the `wasabi` service env.
- For higher scale later, swap the SQLite store (`lib/db.ts`) for Postgres — the store interface is isolated. SQLite is plenty for the team's experiment count.
