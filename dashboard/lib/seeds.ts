// ============================================================================
// Wasabi — canonical seed experiments.
// ----------------------------------------------------------------------------
// Single source of truth for the experiments that ship out-of-the-box. Imported
// by lib/store.ts (which seeds on an empty DB) and scripts/reseed.ts (which
// wipes + re-applies for the live DB).
//
// Edit this file to change what a fresh deploy looks like — run reseed.ts to
// push the change to an already-populated DB.
// ============================================================================
import type { ExperimentInput } from "./mgmt";
import type { MetricInput } from "./metrics";

export const SEED: ExperimentInput[] = [
  // ─── SAMPLE TESTS (active) ───────────────────────────────────────────────
  {
    name: "TU — Billing UK: £19 (14-day) vs £39 (30-day)",
    key: "tu-billing-uk",
    business: "Top Up",
    goalMetric: "revenue_per_acquired",
    startDate: "2026-05-07",
    description:
      "Tests whether the £19 / 14-day SKU lifts net revenue per acquired UK customer vs the £39 / 30-day default. The £19 arm collected rebills at ~2× in the live VWO run — Wasabi confirms it with the auth + rebill + LTV cut VWO structurally can't see.",
    variants: [
      { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
      { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
    ],
  },
  {
    name: "TU — Reward page: default vs IE Serenity",
    key: "tu-reward-page",
    business: "Top Up",
    goalMetric: "revenue_per_acquired",
    startDate: "2026-05-07",
    description:
      "Different lever from price: tests whether the 'IE Serenity' reward-page layout (calmer hero, simpler upsell) lifts net revenue per acquired customer vs the current default. Shows the platform measures copy / layout tests too — not just SKU price.",
    variants: [
      { key: "a", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
      { key: "b", rolloutPercentage: 50, themeSlug: "tu_lov_ie_serenity", isControl: false },
    ],
  },
  {
    name: "AC — Quarterly €79 (control) vs Biweekly €24.90",
    key: "ac-billing-24-9",
    business: "Airport Check-In",
    goalMetric: "revenue_per_acquired",
    startDate: "2026-06-22",
    description:
      "Current default is the €79 / 90-day plan; this test introduces a shorter €24.90 / 14-day plan. Hypothesis: lower up-front friction lifts trial→paid conversion AND rebill volume, even with a smaller ticket — same pattern that played out on TU UK. Active in wasabi; first live traffic awaits the AC storefront middleware wire-up.",
    variants: [
      { key: "quarterly_79", rolloutPercentage: 50, themeSlug: "ac_mto_lov", isControl: true },
      { key: "biweekly_24_9", rolloutPercentage: 50, themeSlug: "ac_mto_lov_24_9", isControl: false },
    ],
  },

  // ─── UPCOMING TESTS (paused — see SEED_PAUSED below) ─────────────────────
  {
    name: "AS — Fast-Track 1-month: £19 (control) vs £14",
    key: "as-billing-1m",
    business: "Airport Security",
    goalMetric: "revenue_per_acquired",
    startDate: "2026-07-01",
    description:
      "Tests whether dropping the 1-month fast-track sub from £19 to £14 lifts net revenue per acquired customer via higher rebill collection. Note: fast-track drives price via ?product=, not the theme suffix; middleware sets BOTH ?product= and ?theme= so attribution still flows. See integration/storefronts/.",
    variants: [
      { key: "control_19", rolloutPercentage: 50, themeSlug: "as_sub_1m_19", isControl: true },
      { key: "variant_14", rolloutPercentage: 50, themeSlug: "as_sub_lov_1m_14", isControl: false },
    ],
  },
  {
    name: "PDF — Auth price: £49 (control) vs £19",
    key: "pdf-price-49-19",
    business: "PDF SaaS",
    goalMetric: "revenue_per_acquired",
    startDate: "2026-07-01",
    description:
      "Tests whether dropping the auth-gate price from £49 to £19 lifts net revenue per acquired PDF customer. Direct price A/B — same lever as TU billing, applied to a different conversion gate. Ready to launch once PDF storefront middleware is wired in.",
    variants: [
      { key: "control_49", rolloutPercentage: 50, themeSlug: "pdf_auth49", isControl: true },
      { key: "variant_19", rolloutPercentage: 50, themeSlug: "pdf_auth19", isControl: false },
    ],
  },
  {
    name: "PDF — EX17: current vs v2 (GP-600 pilot)",
    key: "pdf-ex17-v2",
    business: "PDF SaaS",
    goalMetric: "revenue_per_acquired",
    startDate: "2026-09-01",
    description:
      "Wasabi pilot (GP-600) — the first test to run on the in-house middleware. Split-URL on we-pdf.com: control = the existing EX17 form, variant = EX17_v2 replicated from the pdf-ai repo. Both arms map to real global-api themes so the auth + rebill + net-revenue read is live from day one; first assignment traffic awaits the PDF storefront wire-up.",
    variants: [
      { key: "control", rolloutPercentage: 50, themeSlug: "pdf_ex17", isControl: true },
      { key: "variant_v2", rolloutPercentage: 50, themeSlug: "pdf_ex17_2", isControl: false },
    ],
  },
];

/** Keys that ship seeded but PAUSED — verify config, then Activate from the UI. */
export const SEED_PAUSED = new Set<string>([
  "as-billing-1m",
  "pdf-price-49-19",
  "pdf-ex17-v2",
]);

// ============================================================================
// Canonical seed metrics — lib/metrics.ts's registry, seeded once on an empty
// `metric` table (see ensureMetricsReady() there), same "seed only when empty
// so a deleted/disabled seed doesn't reappear" rule as SEED above.
// ----------------------------------------------------------------------------
// The first three keys (auth_rate, rebill_rate, rev_per_acquired) are NOT
// arbitrary — they are the exact metric keys the pre-registry code hardcoded
// in lib/verdict.ts, lib/metabase.ts's VariantRow, and
// components/LiveResults.tsx. Keeping the same keys, same numerator/
// denominator/value fields, and same direction means buildVerdict() produces
// byte-identical winners/significance for these three, so the (untouched
// this batch) results UI keeps rendering them exactly as before. The other
// three (apps_acquired, net_revenue, break_even_cac) surface P&L fields the
// results table already displays directly off VariantRow — this just makes
// them registry metrics too, so a future batch can render them generically.
// ============================================================================
export const SEED_METRICS: MetricInput[] = [
  {
    key: "auth_rate",
    label: "Auth rate",
    description: "First-payment success rate — paid ÷ (paid + failed).",
    kind: "ratio",
    direction: "higher_is_better",
    unit: "percent",
    numeratorField: "firstPaid",
    denominatorField: "firstPaid+firstFailed",
    decimals: 1,
    isGoal: true,
    showInTable: true,
    displayOrder: 10,
    enabled: true,
  },
  {
    key: "rebill_rate",
    label: "Rebill rate",
    description: "Renewal success rate — rebill ÷ (rebill + rebill_failed).",
    kind: "ratio",
    direction: "higher_is_better",
    unit: "percent",
    numeratorField: "rebillOk",
    denominatorField: "rebillOk+rebillFail",
    decimals: 1,
    isGoal: true,
    showInTable: true,
    displayOrder: 20,
    enabled: true,
  },
  {
    key: "rev_per_acquired",
    label: "Revenue per acquired",
    description: "Cash collected ÷ apps acquired — the £ verdict per arm.",
    kind: "continuous",
    direction: "higher_is_better",
    unit: "currency",
    valueField: "revPerAcquired",
    decimals: 2,
    isGoal: true,
    showInTable: true,
    displayOrder: 30,
    enabled: true,
  },
  {
    key: "apps_acquired",
    label: "Apps acquired",
    description:
      "Distinct applications acquired in the cohort — the conversion count (stands in for GOAL_METRICS' \"conversion\" choice).",
    kind: "sum",
    direction: "higher_is_better",
    unit: "count",
    valueField: "appsAcquired",
    decimals: 0,
    isGoal: true,
    showInTable: true,
    displayOrder: 40,
    enabled: true,
  },
  {
    key: "net_revenue",
    label: "Net revenue",
    description: "Revenue − refunds − chargebacks.",
    kind: "sum",
    direction: "higher_is_better",
    unit: "currency",
    valueField: "netRevenueGbp",
    decimals: 2,
    isGoal: false,
    showInTable: true,
    displayOrder: 50,
    enabled: true,
  },
  {
    key: "break_even_cac",
    label: "Break-even CAC",
    description: "Net revenue ÷ apps acquired — the most you can pay per acquisition.",
    kind: "continuous",
    direction: "higher_is_better",
    unit: "currency",
    valueField: "breakEvenCacGbp",
    decimals: 2,
    isGoal: false,
    showInTable: true,
    displayOrder: 60,
    enabled: true,
  },
];
