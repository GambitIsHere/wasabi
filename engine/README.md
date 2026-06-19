# wasabi-engine — lean, PostHog-esque experimentation core

A tiny in-house experimentation engine: **PostHog's developer experience, our backend, our data.** No ClickHouse, no Kafka, no Docker — just TypeScript on our existing Postgres.

## Why "PostHog-esque"
- **Same assignment algorithm** — `hashValue()` is byte-for-byte compatible with PostHog's feature-flag hashing (`sha1(`${key}.${distinctId}${salt}`)`, first 15 hex / 2^60-1). The official PostHog SDKs would assign users into the *same* variants against our endpoint.
- **Same contract** — `getFeatureFlag(flag, distinctId)` returns `false` | `true` | `"<variant>"`, exactly like PostHog's SDK. An experiment = a multivariate flag + a goal metric.
- **Sticky + storage-free** — assignment is a pure function of `(key, distinctId)`; returning users stay put with no DB lookup. Persisting assignments is optional, only for audit.

## What's here
| File | Role |
|---|---|
| `src/hash.ts` | deterministic [0,1) hash (PostHog-compatible) |
| `src/assignment.ts` | `getFeatureFlag` / `isFeatureEnabled` — the heart |
| `src/types.ts` | `FeatureFlag`, `Variant`, `FlagValue`, `ThemeMap` |
| `scripts/verify.ts` | proof-of-life on the real TU £19-vs-£39 test |

## Run
```bash
node scripts/verify.ts     # Node 25 runs TS directly (type-stripping)
npm run typecheck          # tsc --noEmit (strict)
```

## Roadmap (next layers)
1. **`/decide` + `/capture` HTTP API** — PostHog wire shape, so SDKs/storefronts call in. (built-in `http`, no deps)
2. **Experiment store** — `experiment` / `variant` tables in Postgres + a tiny admin.
3. **Storefront hook** — Next.js middleware: `getFeatureFlag` → set `?theme=` (theme-resolver unchanged).
4. **Payment-event bridge** — attribute `Transaction` outcomes (auth/rebill/churn) to the variant — the P&L tie VWO can't do.
5. **Results + decision-helper** — Metabase models (auth/rebill/LTV per variant) + the business verdict.
