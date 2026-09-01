// ============================================================================
// mgmt.ts — behavioural tests for validateInput, slugify, splitTotal.
// ----------------------------------------------------------------------------
// validateInput is the single source of truth shared by the client form and
// the server action, so every business rule it enforces gets its own test:
// each failure mode isolated (only the field under test is invalid — every
// other field is a valid baseline), asserting the exact returned message.
// Imports via "@/lib/mgmt" to also exercise the `@/` path alias under Vitest.
// ============================================================================
import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_MAX,
  slugify,
  splitTotal,
  validateInput,
  type ExperimentInput,
  type VariantInput,
} from "@/lib/mgmt";

/**
 * validateInput takes the allowed goal-metric set as an explicit parameter
 * now (it moved from a module constant to the registry — see lib/mgmt.ts's
 * header on validateInput). Every test below that isn't specifically about
 * goal-metric validation just wants a realistic, always-valid default, so
 * `validate()` supplies one — mirroring 4 of the real seeded registry keys
 * (lib/seeds.ts's SEED_METRICS) without this pure-module test depending on
 * the DB-backed registry itself.
 */
const ALLOWED_GOAL_METRICS = ["auth_rate", "rebill_rate", "rev_per_acquired", "apps_acquired"];
function validate(input: ExperimentInput, allowed: readonly string[] = ALLOWED_GOAL_METRICS) {
  return validateInput(input, allowed);
}

/** A fresh, fully valid input — each test overrides only what it's testing. */
function validInput(overrides: Partial<ExperimentInput> = {}): ExperimentInput {
  return {
    name: "TU Billing UK Test",
    business: "Top Up",
    goalMetric: "auth_rate",
    startDate: "2026-09-01",
    description: "Cheaper SKU vs the default £49 plan.",
    variants: [
      { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
      { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
    ],
    ...overrides,
  };
}

describe("validateInput — valid input", () => {
  it("returns null for a fully valid input", () => {
    expect(validate(validInput())).toBeNull();
  });

  it("accepts a description at exactly the length cap (boundary, not off-by-one)", () => {
    expect(validate(validInput({ description: "a".repeat(DESCRIPTION_MAX) }))).toBeNull();
  });

  it("accepts an explicit, valid key (the default fixture already covers the omitted-key/derived-via-slugify path)", () => {
    expect(validate(validInput({ key: "custom-experiment-key" }))).toBeNull();
  });
});

describe("validateInput — failure modes", () => {
  it("rejects an empty name", () => {
    expect(validate(validInput({ name: "" }))).toBe("Name is required.");
    expect(validate(validInput({ name: "   " }))).toBe("Name is required.");
  });

  it("rejects a description over the length cap", () => {
    const msg = validate(validInput({ description: "a".repeat(DESCRIPTION_MAX + 1) }));
    expect(msg).toBe(
      `Description must be ${DESCRIPTION_MAX} characters or fewer (currently ${DESCRIPTION_MAX + 1}).`,
    );
  });

  it("rejects a business outside the allowed set", () => {
    const msg = validate(validInput({ business: "Not A Real Business" }));
    expect(msg).toMatch(/^Business must be one of:/);
  });

  it("rejects a goal metric outside the allowed set", () => {
    const msg = validate(validInput({ goalMetric: "clicks" }));
    expect(msg).toMatch(/^Goal metric must be one of:/);
  });

  it("the allowed set is a real parameter, not a hidden module constant — the SAME goalMetric is valid or invalid purely depending on what's passed in", () => {
    const input = validInput({ goalMetric: "rebill_rate" });
    // Valid against a set that includes it…
    expect(validateInput(input, ["auth_rate", "rebill_rate"])).toBeNull();
    // …and rejected against one that doesn't, even though "rebill_rate" is a
    // perfectly real metric key in the app's actual registry today. Proves
    // validateInput trusts its caller's list, not some default it fell back to.
    expect(validateInput(input, ["auth_rate"])).toMatch(/^Goal metric must be one of: auth_rate\.$/);
  });

  it("accepts a goal metric that exists ONLY because the caller explicitly included it — the degrade-gracefully case for an experiment created before the registry, or whose goal metric was since renamed", () => {
    const input = validInput({ goalMetric: "revenue_per_acquired" });
    // Not one of the current registry's real keys — app/actions.ts's
    // updateExperiment unions an experiment's own current goalMetric into the
    // allowed set specifically so this keeps validating instead of blocking
    // every future edit to that experiment.
    const allowedWithLegacyValue = [...ALLOWED_GOAL_METRICS, "revenue_per_acquired"];
    expect(validateInput(input, allowedWithLegacyValue)).toBeNull();
  });

  it("rejects a malformed start date", () => {
    expect(validate(validInput({ startDate: "01/09/2026" }))).toBe(
      "Start date must be a valid date (YYYY-MM-DD).",
    );
  });

  it("rejects a bad explicit key (uppercase / spaces / punctuation)", () => {
    const msg = validate(validInput({ key: "Bad Key!" }));
    expect(msg).toBe(
      "Key must be lower-case letters, numbers and hyphens (e.g. tu-billing-uk).",
    );
  });

  it("rejects when the auto-derived key (slugify of an all-punctuation name) is empty", () => {
    const msg = validate(validInput({ name: "!!!" }));
    expect(msg).toBe(
      "Key must be lower-case letters, numbers and hyphens (e.g. tu-billing-uk).",
    );
  });

  it("rejects fewer than 2 variants", () => {
    const msg = validate(
      validInput({
        variants: [{ key: "control", rolloutPercentage: 100, themeSlug: "tu_lov_uk", isControl: true }],
      }),
    );
    expect(msg).toBe("An experiment needs at least 2 variants.");
  });

  it("rejects an invalid variant key", () => {
    const msg = validate(
      validInput({
        variants: [
          { key: "Bad Key", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
          { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
        ],
      }),
    );
    expect(msg).toMatch(/^Variant key "Bad Key" is invalid/);
  });

  it("rejects duplicate variant keys", () => {
    const msg = validate(
      validInput({
        variants: [
          { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
          { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
        ],
      }),
    );
    expect(msg).toBe('Duplicate variant key "control".');
  });

  it("rejects a non-integer or out-of-range rollout percentage", () => {
    const nonInteger = validate(
      validInput({
        variants: [
          { key: "control", rolloutPercentage: 50.5, themeSlug: "tu_lov_uk", isControl: true },
          { key: "variant_19", rolloutPercentage: 49.5, themeSlug: "tu_lov_uk_19", isControl: false },
        ],
      }),
    );
    expect(nonInteger).toMatch(/split must be a whole number between 0 and 100/);

    const outOfRange = validate(
      validInput({
        variants: [
          { key: "control", rolloutPercentage: 120, themeSlug: "tu_lov_uk", isControl: true },
          { key: "variant_19", rolloutPercentage: -20, themeSlug: "tu_lov_uk_19", isControl: false },
        ],
      }),
    );
    expect(outOfRange).toMatch(/split must be a whole number between 0 and 100/);
  });

  it("rejects an invalid theme slug", () => {
    const msg = validate(
      validInput({
        variants: [
          { key: "control", rolloutPercentage: 50, themeSlug: "UPPERCASE_NOT_ALLOWED", isControl: true },
          { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
        ],
      }),
    );
    expect(msg).toMatch(/^Variant "control" theme slug "UPPERCASE_NOT_ALLOWED" is invalid/);
  });

  it("rejects variant splits that don't sum to exactly 100", () => {
    const msg = validate(
      validInput({
        variants: [
          { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
          { key: "variant_19", rolloutPercentage: 40, themeSlug: "tu_lov_uk_19", isControl: false },
        ],
      }),
    );
    expect(msg).toBe("Variant splits must sum to exactly 100% (currently 90%).");
  });

  it("rejects when no variant is marked as the control", () => {
    const msg = validate(
      validInput({
        variants: [
          { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: false },
          { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
        ],
      }),
    );
    expect(msg).toBe("Exactly one variant must be marked as the control.");
  });

  it("rejects when more than one variant is marked as the control", () => {
    const msg = validate(
      validInput({
        variants: [
          { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
          { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: true },
        ],
      }),
    );
    expect(msg).toBe("Exactly one control allowed — 2 are marked.");
  });
});

describe("slugify", () => {
  it("matches the documented example exactly", () => {
    expect(slugify("Top-Up Billing UK!")).toBe("top-up-billing-uk");
  });

  it("lower-cases and collapses runs of non-alphanumeric characters to a single hyphen", () => {
    expect(slugify("Global   Visa & Tickets!!")).toBe("global-visa-tickets");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  --Airport Check-In--  ")).toBe("airport-check-in");
  });

  it("passes an already-clean kebab string through unchanged", () => {
    expect(slugify("tu-billing-uk")).toBe("tu-billing-uk");
  });

  it("returns an empty string for input with no alphanumeric characters", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("   ")).toBe("");
  });
});

describe("splitTotal", () => {
  it("sums the rollout percentages across variants", () => {
    const variants: VariantInput[] = [
      { key: "a", rolloutPercentage: 50, themeSlug: "x", isControl: true },
      { key: "b", rolloutPercentage: 50, themeSlug: "y", isControl: false },
    ];
    expect(splitTotal(variants)).toBe(100);
  });

  it("sums three unequal splits correctly", () => {
    const variants: VariantInput[] = [
      { key: "a", rolloutPercentage: 34, themeSlug: "x", isControl: true },
      { key: "b", rolloutPercentage: 33, themeSlug: "y", isControl: false },
      { key: "c", rolloutPercentage: 33, themeSlug: "z", isControl: false },
    ];
    expect(splitTotal(variants)).toBe(100);
  });

  it("returns 0 for an empty variant list", () => {
    expect(splitTotal([])).toBe(0);
  });

  it("is tolerant of a non-numeric rolloutPercentage (treats it as 0, not NaN)", () => {
    const variants = [
      { key: "a", rolloutPercentage: 60, themeSlug: "x", isControl: true },
      { key: "b", rolloutPercentage: undefined as unknown as number, themeSlug: "y", isControl: false },
    ];
    expect(splitTotal(variants)).toBe(60);
  });
});
