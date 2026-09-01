// ============================================================================
// assignment.ts — behavioural tests for getFeatureFlag / isFeatureEnabled.
// ----------------------------------------------------------------------------
// This is the heart of the engine: rollout gating, then (for experiments)
// cumulative-bucket variant selection. Several tests here check the assignment
// logic AGAINST the real hashValue() output (not a mock) — e.g. "everyone with
// h > rollout/100 is excluded" — so they verify the actual documented
// invariant rather than re-asserting whatever the code happens to return.
// ============================================================================
import { describe, expect, it } from "vitest";
import { getFeatureFlag, isFeatureEnabled } from "./assignment";
import { hashValue } from "./hash";
import type { FeatureFlag } from "./types";

const N_IDS = 3000;
const ids = Array.from({ length: N_IDS }, (_, i) => `synthetic-user-${i}`);

describe("getFeatureFlag", () => {
  it("returns false for an inactive flag, regardless of rollout or distinctId", () => {
    const flag: FeatureFlag = {
      key: "inactive-flag",
      active: false,
      rolloutPercentage: 100,
      variants: [
        { key: "control", rolloutPercentage: 50 },
        { key: "treatment", rolloutPercentage: 50 },
      ],
    };
    for (const id of ids.slice(0, 100)) {
      expect(getFeatureFlag(flag, id)).toBe(false);
    }
  });

  it("excludes exactly the distinctIds whose hash falls above the rollout percentage", () => {
    const flag: FeatureFlag = {
      key: "rollout-gate-flag",
      active: true,
      rolloutPercentage: 30,
    };
    let includedCount = 0;
    for (const id of ids) {
      const h = hashValue(flag.key, id);
      const value = getFeatureFlag(flag, id);
      if (h > 0.3) {
        expect(value).toBe(false);
      } else {
        expect(value).toBe(true);
        includedCount++;
      }
    }
    // Sanity: the 30% rollout should include roughly 30% of ids (generous
    // tolerance — the point is "roughly", not an exact statistical bound).
    const fraction = includedCount / N_IDS;
    expect(fraction).toBeGreaterThan(0.2);
    expect(fraction).toBeLessThan(0.4);
  });

  it("a 0% rollout excludes everyone", () => {
    const flag: FeatureFlag = { key: "zero-rollout-flag", active: true, rolloutPercentage: 0 };
    for (const id of ids.slice(0, 200)) {
      expect(getFeatureFlag(flag, id)).toBe(false);
    }
  });

  it("a 100% rollout includes everyone", () => {
    const boolFlag: FeatureFlag = { key: "full-rollout-bool", active: true, rolloutPercentage: 100 };
    const multiFlag: FeatureFlag = {
      key: "full-rollout-multi",
      active: true,
      rolloutPercentage: 100,
      variants: [
        { key: "control", rolloutPercentage: 50 },
        { key: "treatment", rolloutPercentage: 50 },
      ],
    };
    for (const id of ids) {
      expect(getFeatureFlag(boolFlag, id)).toBe(true);
      expect(getFeatureFlag(multiFlag, id)).not.toBe(false);
    }
  });

  it("a boolean flag (no variants) resolves to true when the user is included", () => {
    const flag: FeatureFlag = { key: "plain-boolean-flag", active: true, rolloutPercentage: 100 };
    for (const id of ids.slice(0, 200)) {
      expect(getFeatureFlag(flag, id)).toBe(true);
    }
    // Also true when variants is present but empty — same "plain boolean" contract.
    const emptyVariants: FeatureFlag = {
      key: "empty-variants-flag",
      active: true,
      rolloutPercentage: 100,
      variants: [],
    };
    expect(getFeatureFlag(emptyVariants, "any-user")).toBe(true);
  });

  it("a multivariate flag picks the variant whose cumulative bucket contains the hash", () => {
    const flag: FeatureFlag = {
      key: "three-way-flag",
      active: true,
      rolloutPercentage: 100,
      variants: [
        { key: "a", rolloutPercentage: 20 }, // [0.0, 0.2)
        { key: "b", rolloutPercentage: 30 }, // [0.2, 0.5)
        { key: "c", rolloutPercentage: 50 }, // [0.5, 1.0)
      ],
    };
    for (const id of ids) {
      const h = hashValue(flag.key, id, "variant");
      const expected = h < 0.2 ? "a" : h < 0.5 ? "b" : "c";
      expect(getFeatureFlag(flag, id)).toBe(expected);
    }
  });

  it("is sticky — the same (flag.key, distinctId) always yields the same result across many calls", () => {
    const flag: FeatureFlag = {
      key: "stickiness-flag",
      active: true,
      rolloutPercentage: 100,
      variants: [
        { key: "control", rolloutPercentage: 34 },
        { key: "variant_a", rolloutPercentage: 33 },
        { key: "variant_b", rolloutPercentage: 33 },
      ],
    };
    for (const id of ids.slice(0, 100)) {
      const first = getFeatureFlag(flag, id);
      for (let call = 0; call < 10; call++) {
        expect(getFeatureFlag(flag, id)).toBe(first);
      }
    }
  });

  it("a 50/50 split lands roughly 50/50 across a few thousand distinctIds", () => {
    const flag: FeatureFlag = {
      key: "fifty-fifty-flag",
      active: true,
      rolloutPercentage: 100,
      variants: [
        { key: "control", rolloutPercentage: 50 },
        { key: "treatment", rolloutPercentage: 50 },
      ],
    };
    let control = 0;
    let treatment = 0;
    for (const id of ids) {
      const value = getFeatureFlag(flag, id);
      if (value === "control") control++;
      else if (value === "treatment") treatment++;
      else throw new Error(`unexpected flag value: ${String(value)}`);
    }
    expect(control + treatment).toBe(N_IDS);
    const controlFraction = control / N_IDS;
    // Generous tolerance (±10pp) — SHA-1-derived buckets are close to uniform
    // well inside this bound at N=3000 (see hash.test.ts), so this is not flaky.
    expect(controlFraction).toBeGreaterThan(0.4);
    expect(controlFraction).toBeLessThan(0.6);
  });

  it("falls back to the last variant when cumulative rollout never reaches the hash (the floating-point tail case)", () => {
    // Deliberately incomplete coverage (only 60% of variant-space is mapped)
    // exercises the exact same fallback line real floating-point rounding
    // would (`return flag.variants[flag.variants.length - 1]!.key`), without
    // depending on finding a distinctId that lands in a vanishingly thin
    // fp-rounding gap right at h≈1.
    const flag: FeatureFlag = {
      key: "incomplete-coverage-flag",
      active: true,
      rolloutPercentage: 100,
      variants: [
        { key: "a", rolloutPercentage: 30 },
        { key: "b", rolloutPercentage: 30 }, // last variant — the fallback target
      ],
    };
    let exercised = 0;
    for (const id of ids) {
      const h = hashValue(flag.key, id, "variant");
      if (h >= 0.6) {
        exercised++;
        expect(getFeatureFlag(flag, id)).toBe("b");
      }
    }
    // Make sure the test actually exercised the branch (~40% of 3000 ids).
    expect(exercised).toBeGreaterThan(500);
  });
});

describe("isFeatureEnabled", () => {
  it("is false for an inactive flag", () => {
    const flag: FeatureFlag = { key: "inactive", active: false, rolloutPercentage: 100 };
    expect(isFeatureEnabled(flag, "any-user")).toBe(false);
  });

  it("is false when the rollout excludes the user", () => {
    const flag: FeatureFlag = { key: "zero-rollout", active: true, rolloutPercentage: 0 };
    expect(isFeatureEnabled(flag, "any-user")).toBe(false);
  });

  it("is true for an included boolean flag", () => {
    const flag: FeatureFlag = { key: "full-rollout", active: true, rolloutPercentage: 100 };
    expect(isFeatureEnabled(flag, "any-user")).toBe(true);
  });

  it("is true for an included multivariate flag, regardless of which variant", () => {
    const flag: FeatureFlag = {
      key: "multi-enabled",
      active: true,
      rolloutPercentage: 100,
      variants: [
        { key: "control", rolloutPercentage: 50 },
        { key: "treatment", rolloutPercentage: 50 },
      ],
    };
    for (const id of ids.slice(0, 200)) {
      expect(isFeatureEnabled(flag, id)).toBe(true);
    }
  });
});
