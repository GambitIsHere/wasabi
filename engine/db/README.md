# wasabi/engine/db — the experiment-definition store

The Postgres store that backs the TypeScript `FeatureFlag` / `Variant` types
(`engine/src/types.ts`). It holds **experiment definitions** plus two
**observational** tables. It is deliberately *not* the system of record for
correctness or for money.

| File | Role |
|---|---|
| `schema.sql` | DDL for the four tables below (read-only-friendly, `BEGIN`/`COMMIT`) |

Apply it with `psql "$WASABI_DATABASE_URL" -f schema.sql`. This is a **separate
database** from global-api — we only ever *read* global-api for results.

## The one rule

> **Definitions + audit, never correctness.**
> Assignment is a deterministic pure function of `(experimentKey, distinctId)`
> — the PostHog-compatible sha1 hash in `engine/src/hash.ts` /
> `engine/src/assignment.ts`. The engine recomputes a user's variant on every
> request and **never reads this store to decide**. So:
> - `wasabi_assignment` is an **audit trail only** — deleting every row changes
>   no assignment.
> - The engine reads `wasabi_experiment` / `wasabi_variant` only to know *which
>   experiments exist and how they split* (the definition), then hashes.

## How the store maps to the TS types

### `FeatureFlag` → `wasabi_experiment`
`engine/src/types.ts`:

```ts
interface FeatureFlag {
  key: string;               // -> wasabi_experiment.key   (UNIQUE)
  active: boolean;           // -> wasabi_experiment.active
  rolloutPercentage: number; // -> wasabi_experiment.rollout_percentage (0..100)
  variants?: Variant[];      // -> rows in wasabi_variant (experiment_id FK)
}
```

A `FeatureFlag` with no `variants` is a **boolean flag**; with `variants` it's an
**experiment** (multivariate flag + goal metric). The extra columns —
`business`, `goal_metric`, `started_at`, `ended_at`, `created_at` — are
admin/report metadata with **no TS field**; the engine's evaluation never needs
them. `started_at` doubles as the cohort start for results.

> Note: `wasabi_experiment.business` is a **human label** (e.g. `"Top Up"`), not
> the global-api `Business.businessId` (which is a UUID). It's reporting
> metadata, not a foreign key across stores.

### `Variant` → `wasabi_variant`
```ts
interface Variant {
  key: string;               // -> wasabi_variant.key  (UNIQUE per experiment_id)
  rolloutPercentage: number; // -> wasabi_variant.rollout_percentage
}
```

`Variant.rolloutPercentage` is the share of the **in-flag** population assigned
to that arm; arms within one experiment should sum to 100. `is_control` is a
reporting convenience — the engine treats no arm specially.

### `ThemeMap` → `wasabi_variant.theme_slug`
```ts
type ThemeMap = Record<string, string>; // variant key -> storefront "?theme=" slug
```

`theme_slug` **is** the `ThemeMap` value, stored on the row. It's the storefront
`?theme=<slug>` a variant key resolves to (e.g. `control → tu_lov_uk`,
`variant_19 → tu_lov_uk_19`), and it is the **cross-store join key**.

## How `theme_slug` ties to global-api `Theme.slug`

`wasabi_variant.theme_slug` **exactly equals** `Theme.slug` in the global-api
Postgres (`global-api/prisma/schema.prisma`: `Theme(themeId, slug UNIQUE, name)`).
That string is the only contract between the two stores and is what lets us tie
a variant to its real payment P&L:

```
wasabi_variant.theme_slug  ===  Theme.slug
        │                          │
        │            Application.themeId -> Theme.themeId
        │                          │
        └──────────────────────────┴──►  Transaction.applicationId -> Application.applicationId
```

So the attribution path for results is:

```
Transaction → Application → Theme.slug → wasabi_variant.theme_slug → variant → experiment
```

Payment outcomes (`Transaction.type`: paid / failed / auth_only / rebill /
rebill_failed / refunds / chargebacks; money in `Transaction.amountGBP`) are read
**from global-api**, never duplicated here. The per-experiment results query
lives in `decision-helper/results.sql`.

## The four tables

| Table | Purpose | System of record? |
|---|---|---|
| `wasabi_experiment` | `FeatureFlag` definitions | yes (definitions) |
| `wasabi_variant` | `Variant` definitions + `theme_slug` (`ThemeMap`) | yes (definitions) |
| `wasabi_assignment` | audit of who-saw-what | **no** — audit only, assignment is deterministic |
| `wasabi_event` | generic funnel events (`/capture` shape), jsonb | yes (non-payment funnel only) |

> `wasabi_event` holds **non-payment** funnel steps only (e.g.
> `checkout_started`). Payment metrics are **never** duplicated here — they come
> from the global-api `"Transaction"` table via `Theme.slug`. Two sources of
> truth for money is a bug, not a feature.
