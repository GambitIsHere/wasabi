// Experiment registry — ported from engine/src/store.ts and extended with the
// metadata the results pipeline needs (controlVariant, startDate, and the
// variant → theme-slug map used by the per-variant P&L query in lib/metabase.ts).
//
// This is the single source of truth for both assignment (which variant a user
// gets, via the engine) and measurement (which theme slugs to read P&L from).
// Read-only at runtime — the stand-in for the future Postgres `experiment` /
// `variant` tables.
import type { FeatureFlag, ThemeMap } from "./engine/types";

/**
 * One registered experiment: the assignable flag, its theme mapping (the
 * storefront `?theme=` integration contract), plus results metadata.
 *
 * The `resultsThemeMap` can include historical arms that are no longer in the
 * live assignment split but still carry P&L worth reading — e.g. tu-billing-uk
 * ran a £39 arm (`variant_39` → `tu_lov_uk_39`) that is now retired from the
 * traffic split but whose cohort still has transactions to measure.
 */
export interface RegisteredExperiment {
  /** The assignable flag (key, active, rollout, live variant split). */
  flag: FeatureFlag;
  /** Human-readable name for the dashboard. */
  name: string;
  /** One-line description of what the experiment tests. */
  description: string;
  /** Live variant key → storefront `?theme=` slug (assignment contract). */
  themeMap: ThemeMap;
  /** The control variant key — the baseline everything is measured against. */
  controlVariant: string;
  /** ISO date (YYYY-MM-DD) the experiment cohort starts (Application.createdAt floor). */
  startDate: string;
  /**
   * Variant key → theme slug for the RESULTS query. A superset of `themeMap`:
   * may include retired/historical arms (e.g. variant_39) that still have P&L.
   * Display order is preserved.
   */
  resultsThemeMap: Array<{ variant: string; themeSlug: string }>;
}

const EXPERIMENTS: RegisteredExperiment[] = [
  {
    flag: {
      key: "tu-billing-uk",
      active: true,
      rolloutPercentage: 100, // everyone in the test
      variants: [
        { key: "control", rolloutPercentage: 50 }, // → tu_lov_uk
        { key: "variant_19", rolloutPercentage: 50 }, // → tu_lov_uk_19
      ],
    },
    name: "Top-Up Billing UK",
    description:
      "Control vs the £19 plan on the UK Top-Up storefront. Goal metric is revenue per acquired customer, with first-payment auth-rate and renewal collection (rebill-rate) as drivers.",
    themeMap: {
      control: "tu_lov_uk",
      variant_19: "tu_lov_uk_19",
    },
    controlVariant: "control",
    startDate: "2026-05-07",
    // Includes the historical £39 arm (variant_39 → tu_lov_uk_39) as a third
    // results column even though the live split is now control / variant_19.
    resultsThemeMap: [
      { variant: "control", themeSlug: "tu_lov_uk" },
      { variant: "variant_19", themeSlug: "tu_lov_uk_19" },
      { variant: "variant_39", themeSlug: "tu_lov_uk_39" },
    ],
  },
  {
    flag: {
      key: "tu-reward-page",
      active: true,
      rolloutPercentage: 100,
      variants: [
        { key: "a", rolloutPercentage: 50 }, // → tu_lov_uk
        { key: "b", rolloutPercentage: 50 }, // → tu_lov_ie_serenity
      ],
    },
    name: "Top-Up Reward Page",
    description:
      "Reward-page layout A vs B on the Top-Up storefront. Goal metric is revenue per acquired customer against the standard UK control theme.",
    themeMap: {
      a: "tu_lov_uk",
      b: "tu_lov_ie_serenity",
    },
    controlVariant: "a",
    startDate: "2026-05-07",
    resultsThemeMap: [
      { variant: "a", themeSlug: "tu_lov_uk" },
      { variant: "b", themeSlug: "tu_lov_ie_serenity" },
    ],
  },
];

// Index by key for O(1) single lookups; the array preserves seed order.
const BY_KEY = new Map<string, RegisteredExperiment>(
  EXPERIMENTS.map((e) => [e.flag.key, e]),
);

/** All registered experiments (seed order) — for the dashboard list and /flags. */
export function getExperiments(): RegisteredExperiment[] {
  return EXPERIMENTS;
}

/** All experiment flags (seed order) — for the engine handlers (/decide, /flags). */
export function getExperimentFlags(): FeatureFlag[] {
  return EXPERIMENTS.map((e) => e.flag);
}

/** A single registered experiment by key, or undefined if not registered. */
export function getExperiment(key: string): RegisteredExperiment | undefined {
  return BY_KEY.get(key);
}

/** A single experiment's live variant → theme-slug map by key, or undefined. */
export function getThemeMap(key: string): ThemeMap | undefined {
  return BY_KEY.get(key)?.themeMap;
}
