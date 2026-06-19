// In-memory experiment registry — the stand-in for the future Postgres
// `experiment` / `variant` tables (README roadmap #2). Read-only at runtime:
// the engine evaluates against whatever is seeded here, and the admin layer
// will later mutate it. Keeping it a plain module means /decide and /flags are
// pure functions of a known fixture set — easy to reason about and test.
import type { FeatureFlag, ThemeMap } from "./types.ts";

/**
 * One registered experiment: the assignable flag plus its theme mapping (the
 * storefront `?theme=` integration contract). We co-locate the `themeMap` with
 * the flag so the store is the single source of truth for both "which variant"
 * and "which theme slug" — the API layer never has to know the slugs itself.
 */
interface RegisteredExperiment {
  flag: FeatureFlag;
  themeMap: ThemeMap;
}

// Seeded to mirror the two real live tests (same keys/splits as scripts/verify.ts):
//   - tu-billing-uk : control vs £19, 50/50  → tu_lov_uk / tu_lov_uk_19
//   - tu-reward-page: a vs b, 50/50          → tu_lov_uk / tu_lov_ie_serenity
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
    themeMap: {
      control: "tu_lov_uk",
      variant_19: "tu_lov_uk_19",
    },
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
    themeMap: {
      a: "tu_lov_uk",
      b: "tu_lov_ie_serenity",
    },
  },
];

// Index by key for O(1) single lookups; the array preserves seed order for listing.
const BY_KEY = new Map<string, RegisteredExperiment>(
  EXPERIMENTS.map((e) => [e.flag.key, e]),
);

/** All registered experiments as flags (seed order) — for /decide and /flags. */
export function getExperiments(): FeatureFlag[] {
  return EXPERIMENTS.map((e) => e.flag);
}

/** A single experiment's flag by key, or undefined if not registered. */
export function getExperiment(key: string): FeatureFlag | undefined {
  return BY_KEY.get(key)?.flag;
}

/** A single experiment's variant→theme-slug map by key, or undefined. */
export function getThemeMap(key: string): ThemeMap | undefined {
  return BY_KEY.get(key)?.themeMap;
}
