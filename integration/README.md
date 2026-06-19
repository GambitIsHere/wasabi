# Wasabi storefront integration

How a Sanjow storefront adopts Wasabi for A/B testing — the Next.js edge hook that
assigns a visitor and routes them to the right `?theme=` slug, replacing VWO's
Split-URL behaviour.

> **The one design rule:** Wasabi ONLY decides which `?theme=` slug a visitor gets.
> The existing `theme-resolver.ts` and `/api/applications` route are **UNCHANGED**.
> Everything downstream of `?theme=` already works; we only add the assignment that
> used to live in VWO.

Files here:
- [`nextjs-middleware.example.ts`](./nextjs-middleware.example.ts) — an illustrative
  `middleware.ts` to drop into a storefront. Heavily commented; shows both decision
  modes (local eval + remote `/decide`). It imports `next/server`, so it is an
  **example**, not a standalone runnable module.

---

## What this replaces — VWO Split-URL → Wasabi

| | VWO Split-URL (before) | Wasabi (after) |
|---|---|---|
| **Where the split happens** | VWO's JS in the browser, after paint | Next.js middleware at the edge, before render |
| **How control is served** | URL `?theme=tu_lov_uk` | rewrite adds `?theme=tu_lov_uk` |
| **How the variant is served** | URL `?theme=tu_lov_uk_19` | rewrite adds `?theme=tu_lov_uk_19` |
| **Stickiness** | VWO cookie | `wasabi_did` cookie + deterministic hash |
| **Downstream pipeline** | theme-resolver + applications route | **identical — untouched** |
| **Results tie to revenue?** | No (VWO can't see `Transaction`) | Yes — `distinctId` becomes `Transaction.customerId` |

The live example is the TU billing test ("TU | Billing test 39 + 19 UK"): control
`?theme=tu_lov_uk` (the £49 default) vs variant `?theme=tu_lov_uk_19` (the £19 SKU),
split 50/50.

---

## Minimal-change adoption (the contract)

Adopting Wasabi is **one new file** in the storefront: `middleware.ts`. Nothing
else changes.

The middleware's only job is to ensure the URL the app renders carries the right
`?theme=` slug. The existing pipeline then runs exactly as it does for a campaign
deep-link. Two proof points from the storefront code that the slug is consumed
correctly:

**1. `?theme=` is read off the URL (so it must be a query param, not just a cookie).**

`prepaid-mobile-recharge-ai/hooks/use-tracking-params.ts` — `getTheme()`:

```ts
export const getTheme = (): string | null => {
  if (typeof window === "undefined") return null;
  const urlParams = new URLSearchParams(window.location.search);
  const fromUrl = urlParams.get("theme");
  ...
};
```

and `app/[locale]/payment/page.tsx` reads it server-side:

```ts
const theme = searchParams.get("theme") || getTheme();
```

→ The slug must live on the URL as `?theme=`. This is why the middleware does a
**URL rewrite** (adds `?theme=<slug>` to the request the app sees) rather than
only setting a theme cookie — today's storefront has no cookie-read path for the
theme, so a bare cookie would be invisible.

**2. The `_NN` suffix drives the product (so `variant_19` → `?theme=tu_lov_uk_19` → `premium_19`).**

`prepaid-mobile-recharge-ai/app/api/applications/route.ts`:

```ts
const themeSuffix = (themeSlug && /_(\d{2,})$/i.exec(themeSlug)?.[1]) || null;
const premiumVariantKey = themeSuffix ? `premium_${themeSuffix}` : null;
const baseProduct =
  (subscription === "premium" && premiumVariantKey && PRODUCTS[premiumVariantKey]
    ? PRODUCTS[premiumVariantKey]
    : PRODUCTS[subscription]) || PRODUCTS.none;
```

→ As long as Wasabi emits the slug `tu_lov_uk_19`, the applications route's existing
regex turns it into `premium_19` → the £19 / 14-day SKU. Wasabi never touches this
file; it just has to produce a slug whose `_NN` suffix already exists in `PRODUCTS`.

**Therefore the entire integration surface is:** pick a `distinctId`, evaluate the
flag, map variant → slug, rewrite `?theme=`. The theme map (`variant_19 → tu_lov_uk_19`)
is the single new piece of config, and it's chosen so the suffix lands on an existing
product key.

---

## The `distinctId` strategy — anon cookie that becomes `Transaction.customerId`

Assignment is a pure function of `(experimentKey, distinctId)` (PostHog-compatible
SHA-1 hash). So the identity we hash on is what makes the test sticky **and** what
ties results back to the DB:

1. **First touch (anonymous).** The middleware reads `wasabi_did`; if absent it mints
   `crypto.randomUUID()` and sets it `httpOnly`. From now on this visitor hashes into
   the same variant on every request and every device-less return — VWO-style
   stickiness with no server state.
2. **Signup.** When the visitor converts, the storefront passes this same id through
   as the customer id, so the `Transaction` row carries it (`Transaction.customerId`).
3. **Results.** Because the assignment key === `Transaction.customerId`, Metabase /
   the decision-helper can attribute **auth / rebill / churn / LTV** to the variant —
   the P&L tie VWO structurally cannot make (VWO never sees the payment events). This
   is the whole reason the engine exists (ARCHITECTURE.md, open question #4).

> Keep one id end-to-end. If you mint a fresh id at signup you break both stickiness
> and attribution. The anon `wasabi_did` IS the customer id, pre- and post-signup.

`httpOnly` is deliberate: the browser never needs the id in JS — it's an assignment /
attribution key, not UI state. Reading/writing it stays server-side (middleware +
the signup call).

---

## Edge vs server placement + the <30ms budget

| | Edge middleware (recommended) | Server component / route |
|---|---|---|
| Runs before render | yes (rewrite, no flash) | partial (already rendering) |
| Cookie set on first touch | yes | yes |
| Local-eval cost | hash only, <1ms | same |
| Remote `/decide` cost | network hop — keep engine same-region | same |

**Budget: < 30ms** for the assignment step (ARCHITECTURE.md open question #2). Two
modes, both shown in the example:

- **(A) Local eval — preferred.** The experiment def is bundled into the edge
  function; `getFeatureFlag()` is a deterministic hash with no network and no DB.
  Sub-millisecond, trivially inside budget. Cost: starting/stopping a test means a
  storefront redeploy (the def lives in code).
- **(B) Remote `/decide`.** The storefront POSTs `{ distinctId }` to the Wasabi
  service and reads back `{ featureFlags, themes }`. Use when experiment defs must
  live only in the Wasabi admin (no redeploy to toggle a test). Costs a network hop,
  so: co-locate the engine in the same region, set a tight timeout (~25ms), and
  **fail safe to control** on slow/error — a test must never take the storefront
  down. The engine already returns the resolved `themes[key]` slug, so remote mode
  can skip the local theme map.

Default to (A). Reach for (B) only when test-toggle-without-deploy is worth the hop.

---

## Adoption checklist

- [ ] Copy `nextjs-middleware.example.ts` → storefront `middleware.ts`.
- [ ] Vendor the engine's `assignment.ts` + `types.ts` (or add Wasabi as a workspace
      dep) and fix the import paths.
- [ ] Set `EXPERIMENT` / `THEME_MAP` for this storefront, keeping every slug's `_NN`
      suffix aligned with an existing `PRODUCTS[premium_NN]` key in the applications
      route.
- [ ] Confirm `DEFAULT_THEME` matches the storefront's current control slug.
- [ ] Pass the `wasabi_did` cookie through as the customer id at signup, so
      `Transaction.customerId` === the assignment key.
- [ ] Retire the corresponding VWO Split-URL campaign.
