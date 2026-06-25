# Architecture — Wasabi (built version, June 2026)

> See [`PROPOSAL.md`](./PROPOSAL.md) Postscript for what changed from the original PostHog-based proposal. This doc describes **the system as built and running** at [`wasabi.sanjow-hub.com`](https://wasabi.sanjow-hub.com).

## The insight
We don't need an experimentation *platform* from scratch — we already own most of the pipeline:
- **Variant → product resolution:** storefronts parse `?theme=tu_lov_uk_19` server-side into the billing/product variant (`prepaid-mobile-recharge-ai/lib/theme-resolver.ts`, `app/api/applications/route.ts` → `premium_NN`).
- **Attribution + tracking:** `Application.themeId` → every `Transaction` carries the variant; `gAdsConversion` ties themes to ad spend.
- **Analysis:** Metabase over the global-api Postgres (we read the live TU billing test this way).

The **only missing piece was assignment** — deciding, server-side and stickily, which variant a visitor gets. We built it in-house, PostHog-wire-compatible so storefronts call one HTTP endpoint and any PostHog SDK would assign the same way.

## Data flow
```
visitor → storefront (Next.js middleware, edge)
        → POST https://wasabi.sanjow-hub.com/api/decide  {distinctId}
                                                          │
                          SHA-1 hash → [0, 1) bucket → variant slug per experiment
                                                          │
        ← {featureFlags: {...}, themes: {tu-billing-uk: "tu_lov_uk_19", ...}}
        → 307-redirect (first visit) or rewrite (return visit) to add ?theme=<slug>
        → existing theme-resolver picks the product/billing variant   [UNCHANGED]
        → Application.themeId persisted → Transaction.themeId         [UNCHANGED]
                                                              │
   Metabase (global-api DB) → decision-helper: auth/rebill/LTV per variant
                                                              │
                              → two-proportion significance test → verdict
```

No payment-event stream needed — variant attribution already lives in the DB (`Theme` → `Transaction`); the verdict reads from there.

## Components — what we built vs reuse
| Component | What | Where |
|---|---|---|
| Assignment engine | PostHog-compatible SHA-1 hash → bucket → variant; `/decide`, `/capture`, `/flags` HTTP; SDK + CLI | `engine/src/` |
| Experiment store | Neon Postgres; CRUD admin UI (create / configure / activate / pause / edit / delete) | `dashboard/lib/store.ts`, `dashboard/app/experiments/` |
| Admin gate | Edge middleware — basic-auth on everything except `/api/decide` and `/api/capture` (storefronts need them public) | `dashboard/middleware.ts` |
| Decision-helper | Metabase-backed live results — per-variant funnel, net rev, break-even CAC, currency-aware, charts; two-proportion significance test → ship/keep-running call | `decision-helper/verdict.ts`, `dashboard/components/LiveResults.tsx` |
| Storefront integration | Drop-in Next.js middleware templates per storefront (TU / AC / AS / PDF); redirect-then-rewrite pattern so both server- and client-side `?theme=` readers stay in sync; fail-safe to control on timeout | `integration/storefronts/` |
| Test backlog | YouTrack read-only API → admin UI surface (turn a ticket into a tracked experiment) | `dashboard/lib/youtrack.ts`, `dashboard/app/backlog/` |

## Assignment — the one technical detail worth knowing
A storage-free, deterministic SHA-1 hash of `"${experimentKey}.${distinctId}${salt}"` — first 15 hex chars / 2^60-1 = a number in `[0, 1)`. Two salts: empty for the rollout gate, `"variant"` for the variant pick. Same inputs → same number on any machine, no DB lookup. PostHog's SDKs use the same scheme, so swapping to/from PostHog later doesn't reshuffle users. See [`engine/src/hash.ts`](../engine/src/hash.ts) and [`engine/src/assignment.ts`](../engine/src/assignment.ts).

`distinctId` = an opaque cookie (`wasabi_did`, v4 UUID, 1-year TTL, httpOnly) the storefront middleware sets on first visit. Threading it to `Transaction.customerId` at signup time is the path for cross-device attribution — see [`integration/README.md`](../integration/README.md).

## Hosting
- **Dashboard + APIs:** Vercel (Next.js standalone build) at `wasabi.sanjow-hub.com`.
- **Experiment store:** Neon Postgres (Vercel's managed integration; `DATABASE_URL` auto-injected).
- **Admin gate:** in-app middleware, basic-auth. Vercel's Deployment Protection is OFF so the public API stays reachable; the middleware re-asserts the gate on every non-public path.
- **Self-host alternative:** Docker + Caddy on the n8n VPS — runbook in [`deploy/INTEGRATE-N8N-VPS.md`](../deploy/INTEGRATE-N8N-VPS.md). Not the canonical path; kept as an escape hatch.

## What we explicitly did NOT build (deferred)
- **Session recording / heatmaps** — the PostHog-original plan would have replaced MS Clarity in the same move. Clarity stays for now; revisit as a separate decision.
- **Persisted capture events** — `/api/capture` is a write-only stub (logs then forgets). Variant attribution lives in the payments DB; the capture endpoint is there for PostHog-SDK compatibility and future telemetry. Add a real sink + rate-limit before relying on it.
- **VWO retirement** — happens as each storefront is wired (TU first).

---

## Appendix — superseded original P0 design

The original proposal in [`PROPOSAL.md`](./PROPOSAL.md) called for **self-hosted PostHog** (ClickHouse + Kafka, ~16 GB VPS). During Phase 0 we adopted the "lean owned assignment service" fallback that proposal explicitly mentions — see the PROPOSAL postscript for the reasoning and trade-off.

For completeness, the original phased plan (now historical):
- **P0 — spike:** PostHog on a VPS · TU billing test as experiment #1 · payment events · £19-vs-£39 by auth/rebill/LTV in-tool. Go/no-go on ops.
- **P1 — one storefront:** full loop on TopUp (assignment + recordings + decision helper); retire its VWO campaigns.
- **P2 — roll out:** all storefronts; VWO off; Clarity folded in.

The current "what's left" is in [`ONE-PAGER.md`](./ONE-PAGER.md).
