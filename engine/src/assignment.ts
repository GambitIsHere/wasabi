import { hashValue } from "./hash.ts";
import type { FeatureFlag, FlagValue } from "./types.ts";

/**
 * Evaluate a flag for a user — the heart of the engine, PostHog-style:
 *
 *   1. Rollout gate (salt ""): is this distinctId included in the flag at all?
 *   2. If multivariate, deterministically pick a variant (salt "variant") by
 *      walking the cumulative rollout buckets.
 *
 * Sticky and storage-free: the same (flag.key, distinctId) always yields the
 * same result, so a returning user stays in their variant with no DB lookup —
 * identical to how PostHog assigns. Persisting the assignment is optional and
 * only for audit/analytics, never for correctness.
 */
export function getFeatureFlag(flag: FeatureFlag, distinctId: string): FlagValue {
  if (!flag.active) return false;

  // 1. Rollout gate.
  if (hashValue(flag.key, distinctId) > flag.rolloutPercentage / 100) return false;

  // Plain boolean flag.
  if (!flag.variants || flag.variants.length === 0) return true;

  // 2. Multivariate variant selection.
  const h = hashValue(flag.key, distinctId, "variant");
  let cumulative = 0;
  for (const variant of flag.variants) {
    cumulative += variant.rolloutPercentage / 100;
    if (h < cumulative) return variant.key;
  }
  // Floating-point safety: hand the tail to the last variant.
  return flag.variants[flag.variants.length - 1]!.key;
}

/** True when the user is in the flag (boolean on, or any variant). */
export function isFeatureEnabled(flag: FeatureFlag, distinctId: string): boolean {
  return getFeatureFlag(flag, distinctId) !== false;
}
