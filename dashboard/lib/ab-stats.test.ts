// ============================================================================
// ab-stats.ts — behavioural tests for the PLAN-side calculator.
// ----------------------------------------------------------------------------
// Strategy for the sample-size math: rather than trust a single magic number,
// each known-value case is cross-checked THREE ways —
//   1. against an independent transcription of the pooled two-proportion
//      formula using LITERATURE z-constants (1.959964, 0.8416212 …), so a bug
//      in normalQuantile or the formula shows up as a mismatch;
//   2. against a published reference band (R's power.prop.test / Evan Miller's
//      calculator, which use this same pooled formula) within a stated ±3%;
//   3. via monotonicity — the direction each knob must move N.
// The z-test / CI / SRM cases assert closed-form hand computations to a tight
// tolerance. Uses "@/lib/ab-stats" to also prove the `@/` alias resolves.
// ============================================================================
import { describe, expect, it } from "vitest";
import {
  analyzeTwoProportion,
  estimateDuration,
  normalQuantile,
  probabilityToBeatControl,
  sampleSizePerArm,
  srmCheck,
} from "@/lib/ab-stats";
import { normalCdf } from "@/lib/verdict";

// Literature standard-normal quantiles — independent of our normalQuantile().
const Z_975 = 1.959963985; // Φ⁻¹(0.975), two-sided α=0.05
const Z_995 = 2.575829304; // Φ⁻¹(0.995), two-sided α=0.01
const Z_80 = 0.841621234; // Φ⁻¹(0.80), power 0.80
const Z_90 = 1.281551566; // Φ⁻¹(0.90), power 0.90
// A p-value this small is unambiguously an SRM alarm (well under SRM_ALPHA).
const SRM_TINY = 1e-6;

/** Independent transcription of the pooled two-proportion sample-size formula
 *  (Fleiss / R power.prop.test), taking the z-values as inputs so it shares no
 *  code with the implementation under test. */
function pooledN(p1: number, p2: number, zA: number, zB: number): number {
  const pBar = (p1 + p2) / 2;
  const sdNull = Math.sqrt(2 * pBar * (1 - pBar));
  const sdAlt = Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil(((zA * sdNull + zB * sdAlt) / (p2 - p1)) ** 2);
}

// ---------------------------------------------------------------------------
// normalQuantile — the added primitive
// ---------------------------------------------------------------------------
describe("normalQuantile", () => {
  // The shared A&S erf caps accuracy at ~1e-6 near the tails (that is the whole
  // engine's numeric floor — we don't ship a second, more precise erf just to
  // tighten a test). 1e-6 in z is far below what any sample-size call rounds on.
  it("matches literature quantiles to ~1e-5", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(Z_975, 5);
    expect(normalQuantile(0.995)).toBeCloseTo(Z_995, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(Z_80, 5);
    expect(normalQuantile(0.9)).toBeCloseTo(Z_90, 5);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 5);
  });

  it("is the inverse of normalCdf (round-trip)", () => {
    // Halley-refined against the same normalCdf, so the round-trip is tight.
    for (const p of [0.001, 0.01, 0.2, 0.5, 0.8, 0.99, 0.999]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 8);
    }
  });

  it("is symmetric about 0.5", () => {
    expect(normalQuantile(0.3)).toBeCloseTo(-normalQuantile(0.7), 8);
  });

  it("returns ±Infinity at the boundaries", () => {
    expect(normalQuantile(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(normalQuantile(1)).toBe(Number.POSITIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------
// sampleSizePerArm — known values, references, monotonicity, edges
// ---------------------------------------------------------------------------
describe("sampleSizePerArm", () => {
  it("matches the independent pooled formula (5% baseline, +1pp absolute)", () => {
    const n = sampleSizePerArm({
      baselineRate: 0.05,
      mde: 0.01,
      mdeType: "absolute",
    });
    // Independent transcription with literature z-values.
    expect(n).toBe(pooledN(0.05, 0.06, Z_975, Z_80)); // 8158
    // Published reference band (R power.prop.test ≈ 8143) within ±3%.
    expect(n).toBeGreaterThan(8143 * 0.97);
    expect(n).toBeLessThan(8143 * 1.03);
  });

  it("matches the independent pooled formula (20% baseline, +5pp absolute)", () => {
    const n = sampleSizePerArm({
      baselineRate: 0.2,
      mde: 0.05,
      mdeType: "absolute",
    });
    expect(n).toBe(pooledN(0.2, 0.25, Z_975, Z_80)); // 1094
    // R power.prop.test / Evan Miller ≈ 1094 for this classic case.
    expect(n).toBeGreaterThan(1094 * 0.97);
    expect(n).toBeLessThan(1094 * 1.03);
  });

  it("treats relative and absolute MDE as equivalent when they name the same target", () => {
    // 10% baseline, +10% relative → 11% == 10% baseline, +1pp absolute → 11%.
    const rel = sampleSizePerArm({ baselineRate: 0.1, mde: 0.1, mdeType: "relative" });
    const abs = sampleSizePerArm({ baselineRate: 0.1, mde: 0.01, mdeType: "absolute" });
    expect(rel).toBe(abs);
    expect(rel).toBe(pooledN(0.1, 0.11, Z_975, Z_80));
  });

  it("defaults to relative MDE, α=0.05, power=0.8, two-sided", () => {
    const withDefaults = sampleSizePerArm({ baselineRate: 0.1, mde: 0.1 });
    const explicit = sampleSizePerArm({
      baselineRate: 0.1,
      mde: 0.1,
      mdeType: "relative",
      alpha: 0.05,
      power: 0.8,
      sides: 2,
    });
    expect(withDefaults).toBe(explicit);
  });

  it("monotonic: a smaller MDE needs a larger sample", () => {
    const big = sampleSizePerArm({ baselineRate: 0.1, mde: 0.05, mdeType: "absolute" });
    const small = sampleSizePerArm({ baselineRate: 0.1, mde: 0.02, mdeType: "absolute" });
    expect(small).toBeGreaterThan(big);
  });

  it("monotonic: higher power needs a larger sample", () => {
    const p80 = sampleSizePerArm({ baselineRate: 0.1, mde: 0.02, mdeType: "absolute", power: 0.8 });
    const p90 = sampleSizePerArm({ baselineRate: 0.1, mde: 0.02, mdeType: "absolute", power: 0.9 });
    expect(p90).toBeGreaterThan(p80);
  });

  it("monotonic: higher confidence (lower α) needs a larger sample", () => {
    const a05 = sampleSizePerArm({ baselineRate: 0.1, mde: 0.02, mdeType: "absolute", alpha: 0.05 });
    const a01 = sampleSizePerArm({ baselineRate: 0.1, mde: 0.02, mdeType: "absolute", alpha: 0.01 });
    expect(a01).toBeGreaterThan(a05);
  });

  it("one-sided needs a smaller sample than two-sided", () => {
    const two = sampleSizePerArm({ baselineRate: 0.1, mde: 0.02, mdeType: "absolute", sides: 2 });
    const one = sampleSizePerArm({ baselineRate: 0.1, mde: 0.02, mdeType: "absolute", sides: 1 });
    expect(one).toBeLessThan(two);
  });

  it("returns Infinity for un-sizeable requests", () => {
    expect(sampleSizePerArm({ baselineRate: 0, mde: 0.1 })).toBe(Infinity); // rate 0
    expect(sampleSizePerArm({ baselineRate: 1, mde: 0.1 })).toBe(Infinity); // rate 1
    expect(sampleSizePerArm({ baselineRate: 0.1, mde: 0 })).toBe(Infinity); // no effect
    // 90% baseline, +20% relative → 108%, an impossible target rate.
    expect(sampleSizePerArm({ baselineRate: 0.9, mde: 0.2, mdeType: "relative" })).toBe(Infinity);
    // out-of-range alpha / power
    expect(sampleSizePerArm({ baselineRate: 0.1, mde: 0.1, alpha: 0 })).toBe(Infinity);
    expect(sampleSizePerArm({ baselineRate: 0.1, mde: 0.1, power: 1 })).toBe(Infinity);
  });

  it("sizes a detectable drop (negative absolute MDE)", () => {
    const n = sampleSizePerArm({ baselineRate: 0.2, mde: -0.05, mdeType: "absolute" });
    expect(n).toBe(pooledN(0.2, 0.15, Z_975, Z_80));
    expect(Number.isFinite(n)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// estimateDuration
// ---------------------------------------------------------------------------
describe("estimateDuration", () => {
  it("rounds days up and reports weeks to one decimal", () => {
    // 1094 per arm × 2 arms = 2188 total; 500/day at full allocation → 4.376 → 5 days.
    const d = estimateDuration({ nPerArm: 1094, variants: 2, dailyTraffic: 500, allocation: 1 });
    expect(d.days).toBe(5);
    expect(d.weeks).toBeCloseTo(0.7, 5);
  });

  it("halving allocation doubles the time", () => {
    // 1000 × 2 = 2000 total; 400/day → 5 days at full, 200/day → 10 days at half.
    const full = estimateDuration({ nPerArm: 1000, variants: 2, dailyTraffic: 400, allocation: 1 });
    const half = estimateDuration({ nPerArm: 1000, variants: 2, dailyTraffic: 400, allocation: 0.5 });
    expect(full.days).toBe(5);
    expect(half.days).toBe(10);
  });

  it("more arms take longer (same per-arm sample)", () => {
    const ab = estimateDuration({ nPerArm: 1000, variants: 2, dailyTraffic: 1000, allocation: 1 });
    const abc = estimateDuration({ nPerArm: 1000, variants: 3, dailyTraffic: 1000, allocation: 1 });
    expect(abc.days).toBeGreaterThan(ab.days);
  });

  it("returns Infinity when there is no usable traffic", () => {
    const none = estimateDuration({ nPerArm: 1000, variants: 2, dailyTraffic: 0, allocation: 1 });
    expect(none.days).toBe(Infinity);
    expect(none.weeks).toBe(Infinity);
    const zeroAlloc = estimateDuration({ nPerArm: 1000, variants: 2, dailyTraffic: 1000, allocation: 0 });
    expect(zeroAlloc.days).toBe(Infinity);
  });

  it("propagates an un-sizeable (Infinity) sample as Infinity duration", () => {
    const d = estimateDuration({ nPerArm: Infinity, variants: 2, dailyTraffic: 1000, allocation: 1 });
    expect(d.days).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// analyzeTwoProportion
// ---------------------------------------------------------------------------
describe("analyzeTwoProportion", () => {
  it("computes rates, uplift, z, p and CI for a significant lift", () => {
    const r = analyzeTwoProportion({
      control: { visitors: 1000, conversions: 100 }, // 10%
      variant: { visitors: 1000, conversions: 130 }, // 13%
    });
    expect(r.rateC).toBeCloseTo(0.1, 10);
    expect(r.rateV).toBeCloseTo(0.13, 10);
    expect(r.absUplift).toBeCloseTo(0.03, 10);
    expect(r.relUplift).toBeCloseTo(0.3, 10);
    expect(r.zScore).toBeCloseTo(2.1028, 3);
    expect(r.pValue).toBeCloseTo(0.0355, 3);
    expect(r.significant).toBe(true);
    // Wald CI (unpooled): [0.03 ± 1.959964·0.0142513] ≈ [0.00207, 0.05793].
    expect(r.ciLow).toBeCloseTo(0.00207, 4);
    expect(r.ciHigh).toBeCloseTo(0.05793, 4);
  });

  it("CI always brackets the observed difference", () => {
    const r = analyzeTwoProportion({
      control: { visitors: 800, conversions: 90 },
      variant: { visitors: 820, conversions: 101 },
    });
    expect(r.ciLow).toBeLessThanOrEqual(r.absUplift);
    expect(r.ciHigh).toBeGreaterThanOrEqual(r.absUplift);
  });

  it("flags a small, within-noise difference as not significant", () => {
    const r = analyzeTwoProportion({
      control: { visitors: 1000, conversions: 100 }, // 10.0%
      variant: { visitors: 1000, conversions: 105 }, // 10.5%
    });
    expect(r.significant).toBe(false);
    expect(r.pValue).toBeGreaterThan(0.05);
  });

  it("two-sided p is symmetric under swapping control and variant", () => {
    const a = analyzeTwoProportion({
      control: { visitors: 1000, conversions: 100 },
      variant: { visitors: 1000, conversions: 130 },
    });
    const b = analyzeTwoProportion({
      control: { visitors: 1000, conversions: 130 },
      variant: { visitors: 1000, conversions: 100 },
    });
    expect(a.pValue).toBeCloseTo(b.pValue, 12);
    expect(a.zScore).toBeCloseTo(-b.zScore, 12); // sign flips, magnitude equal
  });

  it("one-sided halves the two-sided p when the variant leads", () => {
    const two = analyzeTwoProportion({
      control: { visitors: 1000, conversions: 100 },
      variant: { visitors: 1000, conversions: 130 },
      sides: 2,
    });
    const one = analyzeTwoProportion({
      control: { visitors: 1000, conversions: 100 },
      variant: { visitors: 1000, conversions: 130 },
      sides: 1,
    });
    expect(one.pValue).toBeCloseTo(two.pValue / 2, 6);
    expect(one.significant).toBe(true);
  });

  it("one-sided treats a losing variant as not significant (p > 0.5)", () => {
    const one = analyzeTwoProportion({
      control: { visitors: 1000, conversions: 130 },
      variant: { visitors: 1000, conversions: 100 },
      sides: 1,
    });
    expect(one.pValue).toBeGreaterThan(0.5);
    expect(one.significant).toBe(false);
  });

  it("handles a zero-conversion control without NaN", () => {
    const r = analyzeTwoProportion({
      control: { visitors: 1000, conversions: 0 },
      variant: { visitors: 1000, conversions: 50 },
    });
    expect(r.rateC).toBe(0);
    expect(r.relUplift).toBe(Infinity); // 0 → something is an infinite relative lift
    expect(Number.isNaN(r.pValue)).toBe(false);
  });

  it("handles empty arms without throwing", () => {
    const r = analyzeTwoProportion({
      control: { visitors: 0, conversions: 0 },
      variant: { visitors: 0, conversions: 0 },
    });
    expect(r.rateC).toBe(0);
    expect(r.rateV).toBe(0);
    expect(r.significant).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// srmCheck
// ---------------------------------------------------------------------------
describe("srmCheck", () => {
  it("flags a nominal 50/50 that came out 60/40 at n=1000", () => {
    const r = srmCheck([600, 400], [50, 50]);
    expect(r.chiSquare).toBeCloseTo(40, 6);
    expect(r.pValue).toBeLessThan(SRM_TINY);
    expect(r.mismatch).toBe(true);
  });

  it("passes a true 50/50 split", () => {
    const exact = srmCheck([500, 500], [50, 50]);
    expect(exact.chiSquare).toBeCloseTo(0, 10);
    expect(exact.mismatch).toBe(false);

    const noisy = srmCheck([510, 490], [50, 50]); // ordinary sampling noise
    expect(noisy.mismatch).toBe(false);
    expect(noisy.pValue).toBeGreaterThan(0.05);
  });

  it("accepts any positive weights as the expected ratio", () => {
    // [1,1] and [50,50] both mean 50/50 — normalised to the observed total.
    expect(srmCheck([600, 400], [1, 1]).chiSquare).toBeCloseTo(
      srmCheck([600, 400], [50, 50]).chiSquare,
      10,
    );
  });

  it("handles a healthy 3-way split (df=2 path)", () => {
    const r = srmCheck([340, 330, 330], [1, 1, 1]);
    expect(r.pValue).toBeGreaterThan(0.05);
    expect(r.mismatch).toBe(false);
  });

  it("flags a broken 3-way split", () => {
    const r = srmCheck([500, 250, 250], [1, 1, 1]);
    expect(r.chiSquare).toBeCloseTo(125, 6);
    expect(r.mismatch).toBe(true);
  });

  it("flags a catastrophic all-to-one-arm split", () => {
    const r = srmCheck([1000, 0], [50, 50]);
    expect(r.mismatch).toBe(true);
    expect(r.pValue).toBeLessThan(SRM_TINY);
  });

  it("returns a safe non-mismatch for degenerate inputs", () => {
    expect(srmCheck([100], [100]).mismatch).toBe(false); // <2 arms
    expect(srmCheck([500, 500], [50, 50, 0]).mismatch).toBe(false); // length mismatch
    expect(srmCheck([0, 0], [50, 50]).mismatch).toBe(false); // no traffic
    expect(srmCheck([500, 500], [100, 0]).mismatch).toBe(false); // zero expected weight
  });
});

// ---------------------------------------------------------------------------
// probabilityToBeatControl
// ---------------------------------------------------------------------------
describe("probabilityToBeatControl", () => {
  it("is 0.5 for identical arms", () => {
    const p = probabilityToBeatControl(
      { visitors: 1000, conversions: 100 },
      { visitors: 1000, conversions: 100 },
    );
    expect(p).toBeCloseTo(0.5, 8);
  });

  it("approaches 1 for a clearly-better variant", () => {
    const p = probabilityToBeatControl(
      { visitors: 1000, conversions: 100 }, // 10%
      { visitors: 1000, conversions: 200 }, // 20%
    );
    expect(p).toBeGreaterThan(0.999);
  });

  it("approaches 0 for a clearly-worse variant", () => {
    const p = probabilityToBeatControl(
      { visitors: 1000, conversions: 200 },
      { visitors: 1000, conversions: 100 },
    );
    expect(p).toBeLessThan(0.001);
  });

  it("is monotonic in the size of the lead", () => {
    const small = probabilityToBeatControl(
      { visitors: 1000, conversions: 100 },
      { visitors: 1000, conversions: 110 },
    );
    const big = probabilityToBeatControl(
      { visitors: 1000, conversions: 100 },
      { visitors: 1000, conversions: 140 },
    );
    expect(big).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0.5);
  });

  it("returns 0.5 (no information) for an empty arm", () => {
    expect(
      probabilityToBeatControl(
        { visitors: 0, conversions: 0 },
        { visitors: 1000, conversions: 100 },
      ),
    ).toBe(0.5);
  });

  it("stays within [0,1], even at extreme separation", () => {
    const p = probabilityToBeatControl(
      { visitors: 5000, conversions: 250 },
      { visitors: 5000, conversions: 400 },
    );
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
    // A blowout that pushes normalCdf to its ceiling must not round past 1.
    const extreme = probabilityToBeatControl(
      { visitors: 100000, conversions: 100 },
      { visitors: 100000, conversions: 50000 },
    );
    expect(extreme).toBeLessThanOrEqual(1);
    expect(extreme).toBeGreaterThan(0.999);
  });
});
