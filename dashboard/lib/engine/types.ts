// PostHog-shaped experimentation primitives. An "experiment" in PostHog is a
// multivariate feature flag + a goal metric; we model the same so our flags,
// SDK, and /decide payloads line up with PostHog's.

/** One arm of a multivariate flag/experiment. Percentages across variants sum to 100. */
export interface Variant {
  /** Stable key, e.g. "control" | "variant_19". Returned as the flag value. */
  key: string;
  /** 0..100 share of the *in-flag* population assigned to this variant. */
  rolloutPercentage: number;
}

/** A feature flag (boolean) or experiment (multivariate). */
export interface FeatureFlag {
  /** The flag/experiment key, e.g. "tu-billing-uk". */
  key: string;
  /** Off entirely when false (everyone gets `false`). */
  active: boolean;
  /** 0..100 — share of users included in the flag at all (the rest get `false`). */
  rolloutPercentage: number;
  /** Present for experiments; omit for a plain boolean flag. */
  variants?: Variant[];
}

/**
 * Result of evaluating a flag for a user — PostHog's `getFeatureFlag` contract:
 * `false` (not in the flag), `true` (boolean flag on), or a variant key (string).
 */
export type FlagValue = boolean | string;

/** Maps an experiment's variant keys to the storefront `?theme=` slugs (the integration contract). */
export type ThemeMap = Record<string, string>;
