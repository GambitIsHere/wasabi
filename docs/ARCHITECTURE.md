# Architecture — Wasabi (self-hosted PostHog + Sanjow glue)

## The insight
We don't need an experimentation *platform* from scratch — we already own most of the pipeline:
- **Variant → product resolution:** storefronts parse `?theme=tu_lov_uk_19` server-side into the billing/product variant (`prepaid-mobile-recharge-ai/lib/theme-resolver.ts`, `app/api/applications/route.ts` → `premium_NN`).
- **Attribution + tracking:** `Application.themeId` → every `Transaction` carries the variant; `gAdsConversion` ties themes to ad spend.
- **Analysis:** Metabase over the global-api Postgres (we read the live TU billing test this way).

The **only missing piece is assignment** — deciding, server-side and stickily, which variant a visitor gets. That's what PostHog provides (plus a UI, stats, and session recording for free).

## Data flow
```
visitor → storefront (edge/middleware)
        → PostHog SDK: getFeatureFlag(experimentKey, distinctId)   [sticky, deterministic hash]
        → map flag value → ?theme=<slug>  (e.g. control→tu_lov_uk, variant→tu_lov_uk_19)
        → existing theme-resolver picks the product/billing variant  [UNCHANGED]
        → Application.themeId persisted → Transaction.businessId/themeId  [UNCHANGED]
                                                              │
   payment events (checkout/paid/rebill/churn) ──────────────┼──► PostHog (capture)  → experiment results, recordings
                                                              └──► Metabase (global-api DB) → decision-helper: auth/rebill/LTV per variant
```

## Components (what we build vs reuse)
| Component | Build or reuse | Notes |
|---|---|---|
| Assignment + experiment UI + stats | **PostHog (self-host)** | feature-flag-driven, server-side, deterministic sticky hashing |
| Session recording / heatmaps | **PostHog** | replaces MS Clarity |
| Variant → `?theme=` map | **build (thin)** | `integration/` — flag value → theme slug per experiment |
| Storefront hook | **build (thin)** | middleware/edge calls PostHog, sets the theme cookie/param; theme-resolver unchanged |
| Payment-event stream | **build** | emit `checkout_started / paid / rebill_ok / rebill_failed / churned` to PostHog with `experiment`+`variant` props (source of truth stays the DB) |
| Decision-helper | **build (light)** | Metabase models (auth/rebill/LTV-by-cycle per variant) + a short narrative; reuses `sanjow-analytics` queries |

## Why PostHog (vs alternatives) — recap
Self-hostable, open-source (no licence cost), modern/maintained, and uniquely **all-in-one** (A/B + analytics + session recording), so it replaces VWO **and** Clarity. Trade-off: heaviest self-host stack (ClickHouse+Kafka). Lighter fallbacks if ops is too much: **GrowthBook** (warehouse-native, A/B only) or a **lean owned assignment service** (our code + Metabase). Full comparison: A/B Testing HQ / this session's notes.

## Phases
- **P0 — spike:** PostHog on a VPS · TU billing test as experiment #1 · payment events · £19-vs-£39 by auth/rebill/LTV in-tool. Go/no-go on ops.
- **P1 — one storefront:** full loop on TopUp (assignment + recordings + decision helper); retire its VWO campaigns.
- **P2 — roll out:** all storefronts; VWO off; Clarity folded in.

## Open questions (to resolve in P0)
1. **Where it runs** — VPS spec (≥16 GB), alongside n8n stack or dedicated.
2. **Assignment placement** — Next.js middleware (edge) vs server component; latency budget (<30ms).
3. **Event source of truth** — emit from `global-api` (authoritative, server-side) rather than the browser, to avoid losing rebill/churn events.
4. **Identity** — `distinctId` = our customer/anon id so PostHog assignment is sticky across devices and matches `Transaction.customerId`.
