// ============================================================================
// verdict.ts — behavioural tests for the statistics (buildVerdict) and the
// Direction bug fix.
// ----------------------------------------------------------------------------
// buildVerdict() now takes an explicit `metrics: MetricDef[]` registry
// alongside rows (see lib/metrics.ts) — every case here builds a small,
// realistic metric-def fixture set and goes through the public function, same
// as a caller (the results route) would. Covers: the two-proportion z-test
// (a known-significant case, a known-not-significant case, and the
// zero-denominator/empty-arm guard — unchanged math, now via the registry),
// per-metric winner selection, delta / relative-delta arithmetic, THE
// DIRECTION BUG FIX (lower_is_better winner selection + significance
// interpretation), continuous metrics never fabricating significance, sum
// metrics getting no significance test, and welchTTest in isolation. Uses
// "@/lib/verdict" / "@/lib/metrics" (not relative paths) to also prove the
// `@/` path alias resolves under Vitest.
// ============================================================================
import { describe, expect, it } from "vitest";
import { buildVerdict, welchTTest, type VariantRow } from "@/lib/verdict";
import { isImprovement, type MetricDef } from "@/lib/metrics";

/** Minimal valid row — tests override only the fields they care about. */
function row(overrides: Partial<VariantRow> & { variant: string }): VariantRow {
  return {
    themeSlug: `theme_${overrides.variant}`,
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

// The three metrics the pre-registry code hardcoded — same keys, same
// numerator/denominator/value fields, same direction as lib/seeds.ts's
// SEED_METRICS, so tests built against this fixture prove parity with the
// live seeded behaviour.
const AUTH_RATE = metricDef({
  key: "auth_rate",
  kind: "ratio",
  direction: "higher_is_better",
  unit: "percent",
  numeratorField: "firstPaid",
  denominatorField: "firstPaid+firstFailed",
});
const REBILL_RATE = metricDef({
  key: "rebill_rate",
  kind: "ratio",
  direction: "higher_is_better",
  unit: "percent",
  numeratorField: "rebillOk",
  denominatorField: "rebillOk+rebillFail",
});
const REV_PER_ACQUIRED = metricDef({
  key: "rev_per_acquired",
  kind: "continuous",
  direction: "higher_is_better",
  unit: "currency",
  valueField: "revPerAcquired",
});
const LEGACY_METRICS: MetricDef[] = [AUTH_RATE, REBILL_RATE, REV_PER_ACQUIRED];

describe("buildVerdict — input contract", () => {
  it("throws when no row is marked as control", () => {
    const rows = [row({ variant: "a" }), row({ variant: "b" })];
    expect(() => buildVerdict(rows, LEGACY_METRICS)).toThrow(/no control row/i);
  });

  it("does not throw on an empty metric registry — an empty verdict, not a crash", () => {
    const rows = [row({ variant: "control", isControl: true }), row({ variant: "a" })];
    const verdict = buildVerdict(rows, []);
    expect(verdict.winners).toEqual([]);
    expect(verdict.significance).toEqual([]);
    expect(verdict.unavailableSignificance).toEqual([]);
    expect(verdict.recommendation).toBe("inconclusive");
    expect(verdict.recommendedVariant).toBeNull();
  });
});

describe("buildVerdict — two-proportion z-test (auth_rate), unchanged math via the registry", () => {
  it("flags a known-significant difference as significant, with a high confidence label", () => {
    const control = row({
      variant: "control",
      isControl: true,
      firstPaid: 500,
      firstFailed: 500, // rate 0.5, n=1000
    });
    const variant = row({
      variant: "variant_a",
      firstPaid: 600,
      firstFailed: 400, // rate 0.6, n=1000
    });

    const verdict = buildVerdict([control, variant], LEGACY_METRICS);
    const test = verdict.significance.find((s) => s.metric.startsWith("auth_rate"));
    expect(test).toBeDefined();

    // z is exact arithmetic (pooled two-proportion formula) — recomputed here
    // independently of verdict.ts, as ground truth.
    const p1 = 600 / 1000;
    const p2 = 500 / 1000;
    const pooled = (600 + 500) / (1000 + 1000);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / 1000 + 1 / 1000));
    const expectedZ = (p1 - p2) / se;

    expect(test!.z).toBeCloseTo(expectedZ, 9);
    expect(test!.significant).toBe(true);
    expect(test!.p).toBeLessThan(0.001);
    expect(test!.label).toBe("99.9%+ confident");

    // Delta / relative-delta math.
    expect(test!.deltaPp).toBeCloseTo(10, 9); // (0.6 - 0.5) * 100
    expect(test!.deltaRel).toBeCloseTo((0.6 - 0.5) / 0.5, 9); // +20%
    expect(test!.controlRate).toBeCloseTo(0.5, 9);
    expect(test!.variantRate).toBeCloseTo(0.6, 9);

    // New this batch: direction + improvement, correct for a higher_is_better metric.
    expect(test!.direction).toBe("higher_is_better");
    expect(test!.improvement).toBe(true);
  });

  it("flags a known-not-significant difference as not significant", () => {
    const control = row({
      variant: "control",
      isControl: true,
      firstPaid: 50,
      firstFailed: 50, // rate 0.50, n=100
    });
    const variant = row({
      variant: "variant_a",
      firstPaid: 53,
      firstFailed: 47, // rate 0.53, n=100 — small sample, small lift
    });

    const verdict = buildVerdict([control, variant], LEGACY_METRICS);
    const test = verdict.significance.find((s) => s.metric.startsWith("auth_rate"));
    expect(test).toBeDefined();

    const p1 = 53 / 100;
    const p2 = 50 / 100;
    const pooled = (53 + 50) / (100 + 100);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / 100 + 1 / 100));
    const expectedZ = (p1 - p2) / se;

    expect(test!.z).toBeCloseTo(expectedZ, 9);
    expect(test!.significant).toBe(false);
    expect(test!.p).toBeGreaterThan(0.05);
    expect(test!.label).toMatch(/^not significant/);
  });

  it("guards the zero-trials / empty-arm case (z=0, p=1, not significant) instead of dividing by zero", () => {
    const control = row({
      variant: "control",
      isControl: true,
      firstPaid: 0,
      firstFailed: 0, // zero auth-rate trials for control
    });
    const variant = row({
      variant: "variant_a",
      firstPaid: 40,
      firstFailed: 10, // has real trials, but control doesn't
    });

    const verdict = buildVerdict([control, variant], LEGACY_METRICS);
    const test = verdict.significance.find((s) => s.metric.startsWith("auth_rate"));
    expect(test).toBeDefined();
    expect(test!.z).toBe(0);
    expect(test!.p).toBe(1);
    expect(test!.significant).toBe(false);
    expect(test!.label).toBe("not significant (p=1.000)");
    expect(Number.isFinite(test!.z)).toBe(true); // never NaN/Infinity from a 0/0

    // Same guard when BOTH arms have zero trials.
    const bothZero = buildVerdict(
      [
        row({ variant: "control", isControl: true, firstPaid: 0, firstFailed: 0 }),
        row({ variant: "variant_a", firstPaid: 0, firstFailed: 0 }),
      ],
      LEGACY_METRICS,
    );
    const bothZeroTest = bothZero.significance.find((s) => s.metric.startsWith("auth_rate"));
    expect(bothZeroTest!.z).toBe(0);
    expect(bothZeroTest!.p).toBe(1);

    // A metric that can't be resolved for control (denominator 0) is skipped
    // from WINNERS entirely — never rendered as a fabricated 0.
    expect(verdict.winners.find((w) => w.metric === "auth_rate")).toBeUndefined();
  });
});

describe("buildVerdict — winner selection per metric", () => {
  it("picks the leading variant independently for each ratio/continuous metric", () => {
    const control = row({
      variant: "control",
      isControl: true,
      firstPaid: 500,
      firstFailed: 500, // auth 50%
      rebillOk: 600,
      rebillFail: 400, // rebill 60%
      revPerAcquired: 10,
    });
    const variantA = row({
      variant: "variant_a",
      firstPaid: 550,
      firstFailed: 450, // auth 55% — wins auth_rate
      rebillOk: 580,
      rebillFail: 420, // rebill 58%
      revPerAcquired: 9,
    });
    const variantB = row({
      variant: "variant_b",
      firstPaid: 520,
      firstFailed: 480, // auth 52%
      rebillOk: 650,
      rebillFail: 350, // rebill 65% — wins rebill_rate
      revPerAcquired: 12, // wins rev_per_acquired
    });

    const verdict = buildVerdict([control, variantA, variantB], LEGACY_METRICS);

    const authWinner = verdict.winners.find((w) => w.metric === "auth_rate")!;
    const rebillWinner = verdict.winners.find((w) => w.metric === "rebill_rate")!;
    const revWinner = verdict.winners.find((w) => w.metric === "rev_per_acquired")!;

    expect(authWinner.winner).toBe("variant_a");
    expect(rebillWinner.winner).toBe("variant_b");
    expect(revWinner.winner).toBe("variant_b");

    // Delta / relative-delta math on the winner too.
    expect(revWinner.controlValue).toBe(10);
    expect(revWinner.winnerValue).toBe(12);
    expect(revWinner.delta).toBeCloseTo(2, 9);
    expect(revWinner.deltaRel).toBeCloseTo((12 - 10) / 10, 9);
  });

  it("the control wins a metric (delta 0) when no challenger beats it", () => {
    const control = row({ variant: "control", isControl: true, revPerAcquired: 20 });
    const variant = row({ variant: "variant_a", revPerAcquired: 15 });

    const verdict = buildVerdict([control, variant], LEGACY_METRICS);
    const revWinner = verdict.winners.find((w) => w.metric === "rev_per_acquired")!;

    expect(revWinner.winner).toBe("control");
    expect(revWinner.delta).toBe(0);
    expect(revWinner.deltaRel).toBe(0);
  });

  it("relative delta is 0 (not NaN/Infinity) when the control's value is 0", () => {
    const control = row({ variant: "control", isControl: true, revPerAcquired: 0 });
    const variant = row({ variant: "variant_a", revPerAcquired: 5 });

    const verdict = buildVerdict([control, variant], LEGACY_METRICS);
    const revWinner = verdict.winners.find((w) => w.metric === "rev_per_acquired")!;

    expect(revWinner.delta).toBe(5);
    expect(revWinner.deltaRel).toBe(0); // guarded: controlValue !== 0 ? … : 0
  });

  it("metricValue's percent scaling matches VariantRow.authRate's pre-registry 0-100 convention", () => {
    // auth_rate's unit is "percent", so metricValue must return e.g. 54.6, not
    // 0.546 — otherwise every consumer that formats it with .toFixed(1)+"%"
    // (components/LiveResults.tsx, untouched this batch) would silently
    // regress from "54.6%" to "0.5%".
    const control = row({ variant: "control", isControl: true, firstPaid: 546, firstFailed: 454 });
    const variant = row({ variant: "variant_a", firstPaid: 600, firstFailed: 400 });
    const verdict = buildVerdict([control, variant], LEGACY_METRICS);
    const authWinner = verdict.winners.find((w) => w.metric === "auth_rate")!;
    expect(authWinner.controlValue).toBeCloseTo(54.6, 9);
    expect(authWinner.winnerValue).toBeCloseTo(60, 9);
  });
});

// ---------------------------------------------------------------------------
// THE DIRECTION BUG FIX — a single-member union used to make every metric
// implicitly "higher is better", so the worst-performing arm on a
// lower_is_better metric (churn rate, refund rate, CAC) would have been
// declared the winner. These tests exercise a lower_is_better metric end to
// end: winner selection AND significance interpretation.
// ---------------------------------------------------------------------------

describe("buildVerdict — Direction bug fix: lower_is_better winner selection", () => {
  const REFUNDS = metricDef({
    key: "refunds_gbp",
    label: "Refunds",
    kind: "continuous",
    direction: "lower_is_better",
    unit: "currency",
    valueField: "refundsGbp",
  });

  it("picks the LOWEST value as the winner, and the delta reads as an improvement", () => {
    const control = row({ variant: "control", isControl: true, refundsGbp: 500 });
    const challenger = row({ variant: "variant_a", refundsGbp: 200 }); // fewer refunds — better

    const verdict = buildVerdict([control, challenger], [REFUNDS]);
    const winner = verdict.winners.find((w) => w.metric === "refunds_gbp")!;

    expect(winner.winner).toBe("variant_a"); // the LOWEST value wins, not the highest
    expect(winner.winnerValue).toBe(200);
    expect(winner.controlValue).toBe(500);
    expect(winner.delta).toBe(-300); // raw arithmetic: winner − control (negative — a drop)
    expect(isImprovement(REFUNDS.direction, winner.delta)).toBe(true); // and it reads as a WIN
  });

  it("does NOT declare the worse (higher-refunds) arm the winner — the exact bug this batch fixes", () => {
    const control = row({ variant: "control", isControl: true, refundsGbp: 100 });
    const worse = row({ variant: "variant_bad", refundsGbp: 900 });

    const verdict = buildVerdict([control, worse], [REFUNDS]);
    const winner = verdict.winners.find((w) => w.metric === "refunds_gbp")!;

    // Pre-fix, buildWinner always picked the row with the HIGHEST value —
    // it would have declared variant_bad (900, the worst arm) the winner.
    expect(winner.winner).toBe("control");
    expect(winner.winnerValue).toBe(100);
    expect(winner.delta).toBe(0);
  });
});

describe("buildVerdict — Direction bug fix: significance interpretation", () => {
  const DECLINE_RATE = metricDef({
    key: "decline_rate",
    label: "Decline rate",
    kind: "ratio",
    direction: "lower_is_better",
    unit: "percent",
    numeratorField: "rebillFail",
    denominatorField: "rebillOk+rebillFail",
  });

  it("marks a statistically significant DROP on a lower_is_better ratio metric as a significant IMPROVEMENT", () => {
    // Same magnitude/n as the known-significant auth_rate fixture above
    // (0.5 → 0.6 lift, n=1000 each side) so significance is guaranteed real.
    const control = row({ variant: "control", isControl: true, rebillOk: 500, rebillFail: 500 }); // decline 50%
    const variant = row({ variant: "variant_a", rebillOk: 600, rebillFail: 400 }); // decline 40% — lower, better

    const verdict = buildVerdict([control, variant], [DECLINE_RATE]);
    const test = verdict.significance.find((s) => s.metric.startsWith("decline_rate"))!;

    expect(test.significant).toBe(true);
    expect(test.deltaPp).toBeLessThan(0); // raw arithmetic: the rate DROPPED
    expect(test.direction).toBe("lower_is_better");
    expect(test.improvement).toBe(true); // THE fix: a significant drop reads as an improvement
  });

  it("marks a statistically significant RISE on a lower_is_better ratio metric as a significant regression", () => {
    const control = row({ variant: "control", isControl: true, rebillOk: 500, rebillFail: 500 });
    const variant = row({ variant: "variant_bad", rebillOk: 400, rebillFail: 600 }); // decline rose to 60% — worse

    const verdict = buildVerdict([control, variant], [DECLINE_RATE]);
    const test = verdict.significance.find((s) => s.metric.startsWith("decline_rate"))!;

    expect(test.significant).toBe(true);
    expect(test.deltaPp).toBeGreaterThan(0);
    expect(test.direction).toBe("lower_is_better");
    expect(test.improvement).toBe(false); // a significant RISE is a regression, not a win
  });
});

// ---------------------------------------------------------------------------
// continuous + sum metrics — significance honesty
// ---------------------------------------------------------------------------

describe("buildVerdict — continuous metrics never fabricate significance", () => {
  it("computes a winner + delta for a continuous metric but reports its significance as unavailable, not fabricated", () => {
    const control = row({ variant: "control", isControl: true, revPerAcquired: 10 });
    const variant = row({ variant: "variant_a", revPerAcquired: 12 });

    const verdict = buildVerdict([control, variant], [REV_PER_ACQUIRED]);

    const winner = verdict.winners.find((w) => w.metric === "rev_per_acquired");
    expect(winner).toBeDefined();
    expect(winner!.winner).toBe("variant_a");
    expect(winner!.delta).toBeCloseTo(2, 9);

    // No SignificanceTest entry — never a fabricated z/p on data with no
    // per-user variance to test.
    expect(verdict.significance.find((s) => s.metric.startsWith("rev_per_acquired"))).toBeUndefined();

    // The gap is reported honestly, not silently.
    const note = verdict.unavailableSignificance.find((u) => u.metric === "rev_per_acquired");
    expect(note).toBeDefined();
    expect(note!.reason.length).toBeGreaterThan(0);
    expect(verdict.narrative).toMatch(/not available for rev_per_acquired/);
  });
});

describe("buildVerdict — sum metrics: winner + delta only, no significance test at all", () => {
  it("computes winner + delta for a sum metric with no significance test AND no unavailable-note (a total has nothing to test)", () => {
    const APPS_ACQUIRED = metricDef({
      key: "apps_acquired",
      kind: "sum",
      direction: "higher_is_better",
      unit: "count",
      valueField: "appsAcquired",
    });
    const control = row({ variant: "control", isControl: true, appsAcquired: 1000 });
    const variant = row({ variant: "variant_a", appsAcquired: 1500 });

    const verdict = buildVerdict([control, variant], [APPS_ACQUIRED]);
    const winner = verdict.winners.find((w) => w.metric === "apps_acquired")!;
    expect(winner.winner).toBe("variant_a");
    expect(winner.delta).toBe(500);

    expect(verdict.significance.find((s) => s.metric.startsWith("apps_acquired"))).toBeUndefined();
    // Unlike continuous metrics, sum metrics get no "unavailable" apology —
    // "no significance test" is definitional, not a limitation.
    expect(verdict.unavailableSignificance.find((u) => u.metric === "apps_acquired")).toBeUndefined();
  });
});

describe("buildVerdict — overall shape", () => {
  it("produces a complete, well-formed Verdict for a realistic multi-variant dataset", () => {
    const control = row({
      variant: "control",
      isControl: true,
      appsAcquired: 5000,
      firstPaid: 2500,
      firstFailed: 2500,
      authRate: 50,
      rebillOk: 1000,
      rebillFail: 500,
      rebillRate: 66.7,
      revenueGbp: 50000,
      revPerAcquired: 10,
    });
    const variant = row({
      variant: "variant_19",
      appsAcquired: 5000,
      firstPaid: 3000,
      firstFailed: 2000,
      authRate: 60,
      rebillOk: 1400,
      rebillFail: 300,
      rebillRate: 82.4,
      revenueGbp: 60000,
      revPerAcquired: 12,
    });

    const verdict = buildVerdict([control, variant], LEGACY_METRICS);

    expect(verdict.controlVariant).toBe("control");
    expect(verdict.significance).toHaveLength(2); // auth_rate + rebill_rate, one non-control variant
    expect(verdict.winners).toHaveLength(3); // auth_rate + rebill_rate + rev_per_acquired
    expect(verdict.unavailableSignificance).toHaveLength(1); // rev_per_acquired (continuous)
    expect(["ship", "keep_running", "inconclusive"]).toContain(verdict.recommendation);
    expect(typeof verdict.narrative).toBe("string");
    expect(verdict.narrative.length).toBeGreaterThan(0);
  });

  it("degrades to inconclusive instead of throwing when the money metric isn't in the registry", () => {
    const control = row({ variant: "control", isControl: true, firstPaid: 500, firstFailed: 500 });
    const variant = row({ variant: "variant_a", firstPaid: 600, firstFailed: 400 });
    const verdict = buildVerdict([control, variant], [AUTH_RATE]); // no rev_per_acquired at all

    expect(verdict.winners.find((w) => w.metric === "rev_per_acquired")).toBeUndefined();
    expect(verdict.recommendation).toBe("inconclusive");
    expect(verdict.recommendedVariant).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// welchTTest — real, unit-tested in isolation, even though buildVerdict can't
// honestly call it yet (see the doc comment on welchTTest in lib/verdict.ts).
// ---------------------------------------------------------------------------

describe("welchTTest", () => {
  it("matches an independently-recomputed Welch statistic for unequal variances", () => {
    const mean1 = 12, variance1 = 4, n1 = 50;
    const mean2 = 10, variance2 = 9, n2 = 40;

    const result = welchTTest(mean1, variance1, n1, mean2, variance2, n2);
    expect(result).not.toBeNull();

    const se = Math.sqrt(variance1 / n1 + variance2 / n2);
    const expectedT = (mean1 - mean2) / se;
    expect(result!.t).toBeCloseTo(expectedT, 9);
    expect(result!.p).toBeGreaterThan(0);
    expect(result!.p).toBeLessThan(1);
  });

  it("reduces to the standard equal-variance two-sample t formula when variances and n match", () => {
    const result = welchTTest(20, 25, 30, 15, 25, 30);
    const se = Math.sqrt(25 / 30 + 25 / 30);
    expect(result).not.toBeNull();
    expect(result!.t).toBeCloseTo((20 - 15) / se, 9);
  });

  it("returns null when either sample has fewer than 2 observations (no variance estimate possible)", () => {
    expect(welchTTest(10, 1, 1, 8, 1, 5)).toBeNull();
    expect(welchTTest(10, 1, 5, 8, 1, 1)).toBeNull();
    expect(welchTTest(10, 1, 0, 8, 1, 5)).toBeNull();
  });

  it("guards zero combined variance (se=0) instead of dividing by zero", () => {
    const result = welchTTest(5, 0, 10, 5, 0, 10);
    expect(result).toEqual({ t: 0, p: 1 });
  });
});
