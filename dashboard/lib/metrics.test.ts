// ============================================================================
// metrics.ts — behavioural tests for the pure registry functions: metricValue
// resolution (all three kinds, divide-by-zero, missing fields),
// parseDenominatorFields' strict allow-listed parsing, ratioComponents, the
// direction-aware isImprovement helper, and validateMetricDef's business
// rules. DB-touching functions (getMetrics, createMetric, …) are exercised
// manually against the local Postgres (see docker-compose.dev.yml /
// LOCAL-DEV.md) rather than here — same split the rest of this codebase uses
// (lib/store.ts, the DB-backed twin of this file, has no .test.ts either;
// scripts/store-selftest.ts is its manual check).
// ============================================================================
import { describe, expect, it } from "vitest";
import {
  VARIANT_ROW_NUMERIC_FIELDS,
  isImprovement,
  metricValue,
  parseDenominatorFields,
  ratioComponents,
  validateMetricDef,
  type MetricDef,
  type MetricInput,
} from "@/lib/metrics";
import type { VariantRow } from "@/lib/verdict";

/** Minimal valid row — tests override only the fields they care about. */
function row(overrides: Partial<VariantRow> = {}): VariantRow {
  return {
    variant: "variant_a",
    themeSlug: "theme_a",
    isControl: false,
    appsAcquired: 0,
    firstPaid: 0,
    firstFailed: 0,
    authRate: 0,
    rebillOk: 0,
    rebillFail: 0,
    rebillRate: 0,
    revenueGbp: 0,
    revPerAcquired: 0,
    ...overrides,
  };
}

/** Minimal valid metric def — tests override only the fields they care about. */
function metricDef(
  overrides: Partial<MetricDef> & { key: string; kind: MetricDef["kind"]; direction: MetricDef["direction"]; unit: MetricDef["unit"] },
): MetricDef {
  return {
    label: overrides.key,
    description: "",
    numeratorField: null,
    denominatorField: null,
    valueField: null,
    decimals: 1,
    isGoal: false,
    showInTable: true,
    displayOrder: 100,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A fresh, fully valid MetricInput — each test overrides only what it's
 *  testing, mirroring lib/mgmt.test.ts's validInput() convention. */
function validMetricInput(overrides: Partial<MetricInput> = {}): MetricInput {
  return {
    key: "auth_rate",
    label: "Auth rate",
    description: "First-payment success rate.",
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// VARIANT_ROW_NUMERIC_FIELDS — the allow-list itself
// ---------------------------------------------------------------------------

describe("VARIANT_ROW_NUMERIC_FIELDS", () => {
  it("includes every numeric field the seeded metrics reference", () => {
    for (const f of [
      "firstPaid", "firstFailed", "rebillOk", "rebillFail",
      "revPerAcquired", "appsAcquired", "netRevenueGbp", "breakEvenCacGbp",
    ]) {
      expect(VARIANT_ROW_NUMERIC_FIELDS).toContain(f);
    }
  });

  it("excludes VariantRow's non-numeric fields", () => {
    for (const f of ["variant", "themeSlug", "isControl", "currency"]) {
      expect(VARIANT_ROW_NUMERIC_FIELDS).not.toContain(f);
    }
  });
});

// ---------------------------------------------------------------------------
// parseDenominatorFields — strict allow-listed "+"-joined field parser
// ---------------------------------------------------------------------------

describe("parseDenominatorFields", () => {
  it("parses a single known field", () => {
    expect(parseDenominatorFields("rebillOk")).toEqual(["rebillOk"]);
  });

  it("parses two known fields joined with +, trimming whitespace", () => {
    expect(parseDenominatorFields("firstPaid+firstFailed")).toEqual(["firstPaid", "firstFailed"]);
    expect(parseDenominatorFields(" firstPaid + firstFailed ")).toEqual(["firstPaid", "firstFailed"]);
  });

  it("rejects an unknown field name", () => {
    expect(parseDenominatorFields("totallyMadeUpField")).toBeNull();
    expect(parseDenominatorFields("firstPaid+notAField")).toBeNull();
  });

  it("rejects malformed expressions (empty segments, stray operators)", () => {
    expect(parseDenominatorFields("firstPaid++firstFailed")).toBeNull();
    expect(parseDenominatorFields("+firstPaid")).toBeNull();
    expect(parseDenominatorFields("firstPaid+")).toBeNull();
    expect(parseDenominatorFields("firstPaid*firstFailed")).toBeNull(); // not "+" — no general evaluator
  });

  it("rejects empty, null and undefined", () => {
    expect(parseDenominatorFields("")).toBeNull();
    expect(parseDenominatorFields("   ")).toBeNull();
    expect(parseDenominatorFields(null)).toBeNull();
    expect(parseDenominatorFields(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ratioComponents — raw numerator/denominator counts (what the z-test needs)
// ---------------------------------------------------------------------------

describe("ratioComponents", () => {
  const AUTH_RATE = metricDef({
    key: "auth_rate",
    kind: "ratio",
    direction: "higher_is_better",
    unit: "percent",
    numeratorField: "firstPaid",
    denominatorField: "firstPaid+firstFailed",
  });

  it("resolves numerator + summed denominator for a real row", () => {
    const r = row({ firstPaid: 60, firstFailed: 40 });
    expect(ratioComponents(AUTH_RATE, r)).toEqual({ numerator: 60, denominator: 100 });
  });

  it("resolves a LEGITIMATE zero-denominator (not missing, just zero trials) rather than nulling it out", () => {
    const r = row({ firstPaid: 0, firstFailed: 0 });
    expect(ratioComponents(AUTH_RATE, r)).toEqual({ numerator: 0, denominator: 0 });
  });

  it("returns null for a non-ratio metric", () => {
    const sum = metricDef({ key: "apps_acquired", kind: "sum", direction: "higher_is_better", unit: "count", valueField: "appsAcquired" });
    expect(ratioComponents(sum, row())).toBeNull();
  });

  it("returns null when the denominator expression is unset", () => {
    const bad = metricDef({ key: "bad", kind: "ratio", direction: "higher_is_better", unit: "percent", numeratorField: "firstPaid", denominatorField: null });
    expect(ratioComponents(bad, row({ firstPaid: 10 }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// metricValue — the value lib/verdict.ts's buildWinner reads
// ---------------------------------------------------------------------------

describe("metricValue — ratio metrics", () => {
  const AUTH_RATE = metricDef({
    key: "auth_rate",
    kind: "ratio",
    direction: "higher_is_better",
    unit: "percent",
    numeratorField: "firstPaid",
    denominatorField: "firstPaid+firstFailed",
  });

  it("returns numerator/denominator scaled to 0-100 when unit is percent", () => {
    expect(metricValue(AUTH_RATE, row({ firstPaid: 60, firstFailed: 40 }))).toBeCloseTo(60, 9);
    expect(metricValue(AUTH_RATE, row({ firstPaid: 1, firstFailed: 3 }))).toBeCloseTo(25, 9);
  });

  it("leaves the value as a 0..1 fraction when unit is \"ratio\" (no ×100)", () => {
    const asRatio = metricDef({ ...AUTH_RATE, unit: "ratio" });
    expect(metricValue(asRatio, row({ firstPaid: 60, firstFailed: 40 }))).toBeCloseTo(0.6, 9);
  });

  it("guards divide-by-zero: returns null, never NaN or Infinity", () => {
    const v = metricValue(AUTH_RATE, row({ firstPaid: 0, firstFailed: 0 }));
    expect(v).toBeNull();
  });

  it("returns null (not 0 or a crash) when a referenced field can't resolve on the row", () => {
    const missingDenominatorField = metricDef({
      key: "auth_rate_bad",
      kind: "ratio",
      direction: "higher_is_better",
      unit: "percent",
      numeratorField: "firstPaid",
      denominatorField: "adClicks", // never set on this fixture (optional, undefined)
    });
    expect(metricValue(missingDenominatorField, row({ firstPaid: 10 }))).toBeNull();
  });

  it("sums a two-field denominator expression exactly like the seeded auth_rate/rebill_rate metrics", () => {
    const rebillRate = metricDef({
      key: "rebill_rate",
      kind: "ratio",
      direction: "higher_is_better",
      unit: "percent",
      numeratorField: "rebillOk",
      denominatorField: "rebillOk+rebillFail",
    });
    expect(metricValue(rebillRate, row({ rebillOk: 82, rebillFail: 18 }))).toBeCloseTo(82, 9);
  });
});

describe("metricValue — continuous and sum metrics", () => {
  it("reads the value field directly for a continuous metric", () => {
    const def = metricDef({ key: "rev_per_acquired", kind: "continuous", direction: "higher_is_better", unit: "currency", valueField: "revPerAcquired" });
    expect(metricValue(def, row({ revPerAcquired: 12.5 }))).toBe(12.5);
  });

  it("reads the value field directly for a sum metric", () => {
    const def = metricDef({ key: "apps_acquired", kind: "sum", direction: "higher_is_better", unit: "count", valueField: "appsAcquired" });
    expect(metricValue(def, row({ appsAcquired: 4321 }))).toBe(4321);
  });

  it("returns null when the value field is unset on the def", () => {
    const def = metricDef({ key: "broken", kind: "continuous", direction: "higher_is_better", unit: "currency", valueField: null });
    expect(metricValue(def, row({ revPerAcquired: 12.5 }))).toBeNull();
  });

  it("returns null (not 0) when the referenced optional field is missing on the row", () => {
    const def = metricDef({ key: "net_revenue", kind: "sum", direction: "higher_is_better", unit: "currency", valueField: "netRevenueGbp" });
    // netRevenueGbp is optional on VariantRow and not set by this fixture.
    expect(metricValue(def, row())).toBeNull();
  });

  it("treats an explicit 0 as a real value, not a missing one", () => {
    const def = metricDef({ key: "apps_acquired", kind: "sum", direction: "higher_is_better", unit: "count", valueField: "appsAcquired" });
    expect(metricValue(def, row({ appsAcquired: 0 }))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isImprovement — the "is this delta actually good" half of the Direction fix
// ---------------------------------------------------------------------------

describe("isImprovement", () => {
  it("a positive delta is an improvement for higher_is_better", () => {
    expect(isImprovement("higher_is_better", 5)).toBe(true);
    expect(isImprovement("higher_is_better", -5)).toBe(false);
    expect(isImprovement("higher_is_better", 0)).toBe(false);
  });

  it("a NEGATIVE delta is an improvement for lower_is_better — the bug fix", () => {
    expect(isImprovement("lower_is_better", -5)).toBe(true);
    expect(isImprovement("lower_is_better", 5)).toBe(false);
    expect(isImprovement("lower_is_better", 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateMetricDef — the same "single error string or null" contract as
// lib/mgmt.ts's validateInput
// ---------------------------------------------------------------------------

describe("validateMetricDef — valid input", () => {
  it("returns null for a fully valid ratio metric", () => {
    expect(validateMetricDef(validMetricInput())).toBeNull();
  });

  it("returns null for a fully valid continuous metric", () => {
    expect(
      validateMetricDef(
        validMetricInput({
          key: "rev_per_acquired",
          kind: "continuous",
          unit: "currency",
          numeratorField: undefined,
          denominatorField: undefined,
          valueField: "revPerAcquired",
        }),
      ),
    ).toBeNull();
  });

  it("returns null for a fully valid sum metric", () => {
    expect(
      validateMetricDef(
        validMetricInput({
          key: "apps_acquired",
          kind: "sum",
          unit: "count",
          numeratorField: undefined,
          denominatorField: undefined,
          valueField: "appsAcquired",
        }),
      ),
    ).toBeNull();
  });

  it("accepts a denominator that's a summed expression of known fields", () => {
    expect(validateMetricDef(validMetricInput({ denominatorField: "rebillOk+rebillFail", numeratorField: "rebillOk" }))).toBeNull();
  });
});

describe("validateMetricDef — failure modes", () => {
  it("rejects a bad key (uppercase, hyphens, leading digit)", () => {
    expect(validateMetricDef(validMetricInput({ key: "Auth-Rate" }))).toMatch(/Metric key must be/);
    expect(validateMetricDef(validMetricInput({ key: "9auth" }))).toMatch(/Metric key must be/);
    expect(validateMetricDef(validMetricInput({ key: "" }))).toMatch(/Metric key must be/);
  });

  it("rejects a missing or empty label", () => {
    expect(validateMetricDef(validMetricInput({ label: "" }))).toBe("Label is required.");
    expect(validateMetricDef(validMetricInput({ label: "   " }))).toBe("Label is required.");
  });

  it("rejects a kind outside the allowed set", () => {
    const msg = validateMetricDef(validMetricInput({ kind: "average" as unknown as MetricInput["kind"] }));
    expect(msg).toMatch(/^Kind must be one of:/);
  });

  it("rejects a direction outside the allowed set", () => {
    const msg = validateMetricDef(validMetricInput({ direction: "sideways" as unknown as MetricInput["direction"] }));
    expect(msg).toMatch(/^Direction must be one of:/);
  });

  it("rejects a unit outside the allowed set", () => {
    const msg = validateMetricDef(validMetricInput({ unit: "furlongs" as unknown as MetricInput["unit"] }));
    expect(msg).toMatch(/^Unit must be one of:/);
  });

  it("rejects decimals out of range", () => {
    expect(validateMetricDef(validMetricInput({ decimals: -1 }))).toMatch(/Decimals must be/);
    expect(validateMetricDef(validMetricInput({ decimals: 1.5 }))).toMatch(/Decimals must be/);
    expect(validateMetricDef(validMetricInput({ decimals: 99 }))).toMatch(/Decimals must be/);
  });

  it("rejects a ratio metric with no numerator field", () => {
    const msg = validateMetricDef(validMetricInput({ numeratorField: undefined }));
    expect(msg).toMatch(/^Numerator field must be one of:/);
  });

  it("rejects a ratio metric whose numerator field is unknown (typo protection)", () => {
    const msg = validateMetricDef(validMetricInput({ numeratorField: "frstPaid" }));
    expect(msg).toMatch(/^Numerator field must be one of:/);
  });

  it("rejects a ratio metric with no denominator field", () => {
    const msg = validateMetricDef(validMetricInput({ denominatorField: undefined }));
    expect(msg).toMatch(/^Denominator field must be/);
  });

  it("rejects a ratio metric whose denominator references an unknown field", () => {
    const msg = validateMetricDef(validMetricInput({ denominatorField: "firstPaid+definitelyNotAField" }));
    expect(msg).toMatch(/^Denominator field must be/);
  });

  it("rejects a continuous/sum metric with no value field", () => {
    const msg = validateMetricDef(
      validMetricInput({ kind: "continuous", unit: "currency", numeratorField: undefined, denominatorField: undefined, valueField: undefined }),
    );
    expect(msg).toMatch(/^Value field must be one of:/);
  });

  it("rejects a continuous/sum metric whose value field is unknown", () => {
    const msg = validateMetricDef(
      validMetricInput({ kind: "sum", unit: "count", numeratorField: undefined, denominatorField: undefined, valueField: "nope" }),
    );
    expect(msg).toMatch(/^Value field must be one of:/);
  });
});
