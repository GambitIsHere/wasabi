# 🌶 Wasabi Dashboard

The web UI for **Wasabi** — Sanjow's in-house, PostHog-compatible
experimentation engine. It lists the running experiments, lets you resolve any
`distinctId` against the live assignment engine (proving sticky, storage-free
variant assignment), and ties every variant back to its real payment P&L to
deliver a **verdict**: which arm actually made more money per acquired customer,
and whether the difference is statistically real.

Built with **Next.js (App Router)** + **React** + **TypeScript (strict)** +
**Tailwind CSS v4**. Deploys to Vercel (Node 24).

## What's inside

- **Experiments dashboard** (`/`) — card list of every registered experiment:
  name, key, status, traffic split, and each variant's `?theme=` route.
- **Experiment detail** (`/experiments/[key]`):
  1. Header — name, key, status, start date, control.
  2. Variants table — variant, weight, theme route, control badge.
  3. **Assignment tester** — enter a `distinctId`, hit the engine, see the
     variant + theme that user gets. Same id ⇒ same arm, always.
  4. **Live results & verdict** — per-variant P&L (auth %, rebill %,
     rev/acquired), two-proportion significance vs control, winner-by-metric,
     and the verdict pill + recommendation narrative.

### Engine & verdict are vendored

The PostHog-compatible assignment core and the verdict logic are **copied** into
`lib/` from the Wasabi monorepo (no edits to the originals):

- `lib/engine/{hash,assignment,types,wire}.ts` — pure engine core.
- `lib/engine/handlers.ts` — `/decide`, `/capture`, `/flags` business logic.
- `lib/verdict.ts` — two-proportion z-test + verdict/narrative builder.
- `lib/experiments.ts` — the experiment registry (ported from the engine's
  `store.ts`, extended with results metadata).
- `lib/metabase.ts` — runs the per-variant P&L query against Metabase.

## API routes

| Route | Method | Body / Params | Returns |
| --- | --- | --- | --- |
| `/api/decide` | POST | `{ distinctId, personProperties? }` | `{ featureFlags, themes }` |
| `/api/capture` | POST | `{ distinctId, event, properties? }` | `{ status: 1 }` |
| `/api/flags` | GET | — | `{ flags: [...] }` |
| `/api/experiments/[key]/results` | GET | `key` | `{ available, rows?, verdict?, reason? }` |

`/api/decide` and `/api/capture` are CORS-permissive so storefronts can call
them from the browser. `/capture` persists one row per event to the `event`
table (Neon), rate-limited to ~60 events/minute/IP and, when
`WASABI_INGEST_KEY` is set, gated behind a matching `x-wasabi-key` header.

## Run locally

```bash
npm install
npm run dev      # http://localhost:3000
```

Smoke-test the API:

```bash
curl http://localhost:3000/api/flags
curl -X POST http://localhost:3000/api/decide \
  -H 'content-type: application/json' \
  -d '{"distinctId":"user_42"}'
```

Production build:

```bash
npm run build
npm run start
```

Lint:

```bash
npm run lint
```

## Environment variables

| Var | Required | Purpose |
| --- | --- | --- |
| `METABASE_URL` | for live results | Base URL of the Metabase instance fronting the global-api Postgres ("MAIN DB - Production"). No trailing slash. e.g. `https://metabase.paynova.app`. |
| `METABASE_API_KEY` | for live results | Metabase API key with read access to "MAIN DB - Production". |
| `WASABI_INGEST_KEY` | optional | Shared secret for `POST /api/capture`. When set, requests must send it back as the `x-wasabi-key` header (401 otherwise). When unset, the endpoint keeps accepting every request but logs a one-time warning. |

**Graceful degradation:** when `METABASE_API_KEY` is unset, the results route
returns `{ available: false, reason: "METABASE_API_KEY not configured" }` and
the detail page shows a clean **"Connect Metabase to see live results"**
empty-state — never an error or a crash. The dashboard, assignment tester, and
all flag routes work fully without it.

See `.env.example`. The Metabase query is **SELECT-only** (native query against
the `Application` / `Theme` / `Transaction` tables).

## Deploy to Vercel

Import the repo, set the project root to `wasabi/dashboard`, and add
`METABASE_URL` + `METABASE_API_KEY` as environment variables (optional — the app
deploys and runs without them, just without live results). Node 24 runtime. No
other configuration needed.
