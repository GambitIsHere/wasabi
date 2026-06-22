# Storefront rollout — Wasabi across all businesses

Ready-to-apply middleware for each Sanjow storefront, so one Wasabi instance fronts
A/B assignment for **all** of them. Each file here is a **template you drop into the
target repo and test** — not auto-applied. The contract (unchanged from
[`../README.md`](../README.md)): **Wasabi only decides which `?theme=` slug a visitor
gets; the storefront's existing theme-resolver does the rest.**

## Decision mode: remote `/api/decide` (chosen)

These templates call the deployed Wasabi service's `POST /api/decide` from the edge,
rather than bundling the experiment defs for local eval. Why, for a first rollout:

- **Correct by construction** — assignment comes from the one source of truth (the
  dashboard's store), so the storefront can never drift from what the admin UI / the
  results query see.
- **Toggle without redeploy** — start/stop/retarget a test from the Wasabi admin; no
  storefront deploy per change.
- **Fail-safe** — a hard ~25 ms timeout and abort; on any slowness/error the
  middleware sets **no** `?theme=`, so the storefront serves its **control** default.
  A test can never take a storefront down.

Trade-off: one edge→Wasabi hop. Co-locate the Wasabi instance in-region. The
local-eval variant (`../nextjs-middleware.example.ts`, sub-ms, no network) is the
**phase-2 perf optimization** once a test is validated — it requires vendoring the
engine kernel and a redeploy to toggle.

Set `WASABI_URL` in each storefront's env to the deployed instance (e.g.
`https://wasabi.<host>`).

## Per-storefront map

| Biz | Repo | File action | Experiment key | Variant → what the middleware sets |
|---|---|---|---|---|
| **TU** | `prepaid-mobile-recharge-ai` | **new** `middleware.ts` | `tu-billing-uk` | `?theme=tu_lov_uk` / `tu_lov_uk_19` (theme drives product) |
| **AC** | `checkin-ai` | **extend** `middleware.ts` | `ac-billing-24-9` | `?theme=ac_mto_lov` / `ac_mto_lov_24_9` (theme drives product) |
| **AS** | `fast-track-ai` | **extend** `src/proxy.ts` | `as-billing-1m` | `?product=_1m_19`+`?theme=as_sub_1m_19` / `?product=_1m_14`+`?theme=as_sub_lov_1m_14` ⚠️ |
| **PDF** | `pdf-ai` | **new** `src/middleware.ts` | `pdf-price-49-19` | `?theme=pdf_auth49` / `pdf_auth19` (theme drives product) |

The TU/AC/PDF experiments map a variant to a single `?theme=` slug whose suffix the
storefront resolves into the product/price. **AS is the exception** — in fast-track
the theme is only a tracking tag (`getTheme()` → `themeSlug`), and **price is driven
by a separate `?product=_Nm_P` param** ([`useTrackingParams.ts:127`](../../../fast-track-ai/src/hooks/useTrackingParams.ts)).
So the AS middleware sets **both**: `?product=` to change the price the user sees,
and `?theme=` so the Application carries a distinct slug for results attribution.

### New vs extend

- **TU, PDF** have no middleware → drop the new file in (TU at repo root, PDF at
  `src/middleware.ts`). See [`tu-prepaid-mobile-recharge-ai.middleware.ts`](./tu-prepaid-mobile-recharge-ai.middleware.ts).
- **AC, AS** already run a `next-intl` + `?design=` middleware
  ([`checkin-ai/middleware.ts`](../../../checkin-ai/middleware.ts),
  [`fast-track-ai/src/proxy.ts`](../../../fast-track-ai/src/proxy.ts)). The Wasabi
  step must be **folded into** those (don't replace) — assign, then set the
  param(s) on the URL the intl layer rewrites to. The `ac.*` / `as.*` templates here
  are full merged versions to diff against the live files.

## Experiments

The four experiment defs ship seeded in `dashboard/lib/store.ts` (`tu-billing-uk` and
`tu-reward-page` active; `ac-billing-24-9`, `as-billing-1m`, `pdf-price-49-19` seeded
**paused**). The AS/PDF tests use real production Theme-table slugs but the **price
hypotheses are proposed — product must sign off before Activate.**

## Identity & attribution (phase 2)

Each template mints a sticky `wasabi_did` httpOnly cookie. Variant-level P&L already
works without anything more (results join `Theme → Application → Transaction` by
slug). To unlock **cross-device stickiness + person-level** attribution, thread
`wasabi_did` through as the customer id at signup so `Transaction.customerId === did`.
Per-repo entry points found during assessment:
- TU: `components/topup/checkout-form.tsx` → `app/api/applications/route.ts`
- AC: `hooks/use-save-order.ts` → `app/api/orders/route.ts`
- AS: `src/hooks/useSaveOrder.ts`
- PDF: `src/hooks/usePaymentRedirect.ts` → `supabase/functions/create-payment-application`

This needs a **global-api** change (it generates `customerId` server-side today), so
it's deliberately deferred — not required for the goal.

## VWO retirement (gated — traffic cutover)

VWO is live in **TU, AC, PDF** (`vwo-smartcode-nextjs`; AC acct 865364); **AS has
none** (GTM only). Recommended: run Wasabi **side-by-side** first, confirm assignment
+ results for one test, then remove the `<VWOScript>` from that storefront's
`layout.tsx`. This is a live-traffic decision — do it per storefront, not in bulk.

## Verify (per storefront, after applying)

1. `curl -s -X POST $WASABI_URL/api/decide -H 'content-type: application/json' -d '{"distinctId":"smoke"}'` → returns the slug for that experiment.
2. Load the storefront; confirm `?theme=<slug>` appears on the rendered URL and the
   price/product matches the variant.
3. Re-load → same variant (sticky via `wasabi_did`).
4. After real traffic, the experiment's results tab in the Wasabi dashboard populates
   for that business's slugs.
