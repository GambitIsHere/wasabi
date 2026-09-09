// ============================================================================
// ab-stats.ts — tests for the PLAN half of the calculator.
// ----------------------------------------------------------------------------
// ON REFERENCE VALUES: the fixtures below are pinned to constants that are
// exactly known and independently checkable — standard-normal quantiles
// (1.959964 at 97.5%, 0.8416212 at 80%) and chi-square critical values
// (3.841459 at df=1, 5.991465 at df=2, both p=0.05). Sample size is checked a
// second way instead: the test recomputes it from the published closed form
// inline and compares. That catches an algebra slip in the module without
// asserting a number copied from a calculator nobody here can re-run.
//
// Properties (monotonicity, symmetry, bracketing) carry the rest: they hold
// for any correct implementation and fail loudly for a wrong one.
// ============================================================================
import { describe, it, expect } from "vitest";
import {
  normalQuantile,
  sampleSizePerArm,
  estimateDuration,
  srmCheck,
  chiSquarePValue,
  probabilityToBeatControl,
  confidenceIntervalDiff,
} from "./ab-stats";
import { normalCdf, twoProportionZTest } from "./verdict";

describe("normalQuantile", () => {
  it("matches the standard normal quantiles the tables give", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.95)).toBeCloseTo(1.644854, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212, 5);
    expect(normalQuantile(0.9)).toBeCloseTo(1.2815516, 5);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
  });

  it("round-trips against the Φ in verdict.ts", () => {
    for (const p of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 6);
    }
  });

  it("is symmetric about 0.5", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(-normalQuantile(0.025), 6);
  });

  it("refuses probabilities outside (0,1)", () => {
    expect(() => normalQuantile(0)).toThrow(RangeError);
    expect(() => normalQuantile(1)).toThrow(RangeError);
  });
});

describe("sampleSizePerArm", () => {
  it("agrees with the closed form computed independently here", () => {
    const p1 = 0.1, rel = 0.1; // 10% baseline, 10% relative lift -> 11%
    const got = sampleSizePerArm({ baselineRate: p1, mde: rel, mdeType: "relative" });

    const delta = p1 * rel;
    const p2 = p1 + delta;
    const pBar = (p1 + p2) / 2;
    const za = 1.959964; // 97.5th percentile, two-sided alpha 0.05
    const zb = 0.8416212; // 80th percentile, power 0.8
    const expected = Math.ceil(
      ((za * Math.sqrt(2 * pBar * (1 - pBar)) +
        zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2) / (delta ** 2),
    );
    expect(got.nPerArm).toBe(expected);
  });

  it("reads relative and absolute MDE differently, and says so in the result", () => {
    const rel = sampleSizePerArm({ baselineRate: 0.2, mde: 0.1, mdeType: "relative" });
    const abs = sampleSizePerArm({ baselineRate: 0.2, mde: 0.1, mdeType: "absolute" });
    expect(rel.absoluteEffect).toBeCloseTo(0.02, 10); // 10% OF 20%
    expect(abs.absoluteEffect).toBeCloseTo(0.1, 10);  // ten points
    expect(rel.targetRate).toBeCloseTo(0.22, 10);
    expect(abs.targetRate).toBeCloseTo(0.3, 10);
    expect(rel.nPerArm).toBeGreaterThan(abs.nPerArm); // smaller effect, more traffic
  });

  it("needs more traffic for a smaller effect", () => {
    const big = sampleSizePerArm({ baselineRate: 0.1, mde: 0.2 });
    const small = sampleSizePerArm({ baselineRate: 0.1, mde: 0.05 });
    expect(small.nPerArm).toBeGreaterThan(big.nPerArm);
  });

  it("needs more traffic for more power", () => {
    const p80 = sampleSizePerArm({ baselineRate: 0.1, mde: 0.1, power: 0.8 });
    const p95 = sampleSizePerArm({ baselineRate: 0.1, mde: 0.1, power: 0.95 });
    expect(p95.nPerArm).toBeGreaterThan(p80.nPerArm);
  });

  it("needs more traffic for tighter confidence", () => {
    const a05 = sampleSizePerArm({ baselineRate: 0.1, mde: 0.1, alpha: 0.05 });
    const a01 = sampleSizePerArm({ baselineRate: 0.1, mde: 0.1, alpha: 0.01 });
    expect(a01.nPerArm).toBeGreaterThan(a05.nPerArm);
  });

  it("needs less traffic one-sided than two-sided", () => {
    const two = sampleSizePerArm({ baselineRate: 0.1, mde: 0.1, sides: 2 });
    const one = sampleSizePerArm({ baselineRate: 0.1, mde: 0.1, sides: 1 });
    expect(one.nPerArm).toBeLessThan(two.nPerArm);
  });

  it("returns whole visitors", () => {
    const r = sampleSizePerArm({ baselineRate: 0.137, mde: 0.083 });
    expect(Number.isInteger(r.nPerArm)).toBe(true);
  });

  it("rejects inputs that are not rates", () => {
    expect(() => sampleSizePerArm({ baselineRate: 0, mde: 0.1 })).toThrow(RangeError);
    expect(() => sampleSizePerArm({ baselineRate: 1, mde: 0.1 })).toThrow(RangeError);
    expect(() => sampleSizePerArm({ baselineRate: 0.1, mde: 0 })).toThrow(RangeError);
    // a lift that pushes the target rate past 100%
    expect(() => sampleSizePerArm({ baselineRate: 0.9, mde: 0.5, mdeType: "absolute" }))
      .toThrow(RangeError);
  });
});

describe("estimateDuration", () => {
  it("divides total visitors by the allocated daily traffic", () => {
    const d = estimateDuration({ nPerArm: 1000, variants: 2, dailyTraffic: 500 });
    expect(d.totalVisitors).toBe(2000);
    expect(d.days).toBe(4);
    expect(d.weeks).toBe(1);
  });

  it("takes longer on a partial allocation", () => {
    const full = estimateDuration({ nPerArm: 1000, variants: 2, dailyTraffic: 500, allocation: 1 });
    const half = estimateDuration({ nPerArm: 1000, variants: 2, dailyTraffic: 500, allocation: 0.5 });
    expect(half.days).toBe(full.days * 2);
  });

  it("takes longer with more arms", () => {
    const two = estimateDuration({ nPerArm: 1000, variants: 2, dailyTraffic: 500 });
    const four = estimateDuration({ nPerArm: 1000, variants: 4, dailyTraffic: 500 });
    expect(four.days).toBe(two.days * 2);
  });

  it("rounds part-days up and part-weeks up", () => {
    const d = estimateDuration({ nPerArm: 100, variants: 2, dailyTraffic: 30 });
    expect(d.days).toBe(7); // 200/30 = 6.67
    expect(d.weeks).toBe(1);
    const e = estimateDuration({ nPerArm: 1000, variants: 2, dailyTraffic: 200 });
    expect(e.days).toBe(10);
    expect(e.weeks).toBe(2); // 10 days is two planning weeks, not 1.4
  });

  it("rejects impossible plans", () => {
    expect(() => estimateDuration({ nPerArm: 0, variants: 2, dailyTraffic: 10 })).toThrow(RangeError);
    expect(() => estimateDuration({ nPerArm: 10, variants: 1, dailyTraffic: 10 })).toThrow(RangeError);
    expect(() => estimateDuration({ nPerArm: 10, variants: 2, dailyTraffic: 0 })).toThrow(RangeError);
    expect(() => estimateDuration({ nPerArm: 10, variants: 2, dailyTraffic: 10, allocation: 0 }))
      .toThrow(RangeError);
  });
});

describe("chiSquarePValue", () => {
  it("matches the critical values in the tables", () => {
    expect(chiSquarePValue(3.841459, 1)).toBeCloseTo(0.05, 4);
    expect(chiSquarePValue(6.634897, 1)).toBeCloseTo(0.01, 4);
    expect(chiSquarePValue(10.827566, 1)).toBeCloseTo(0.001, 4);
    expect(chiSquarePValue(5.991465, 2)).toBeCloseTo(0.05, 4);
    expect(chiSquarePValue(7.814728, 3)).toBeCloseTo(0.05, 4);
  });

  it("is 1 at zero and falls monotonically", () => {
    expect(chiSquarePValue(0, 1)).toBe(1);
    expect(chiSquarePValue(1, 1)).toBeGreaterThan(chiSquarePValue(5, 1));
  });
});

describe("srmCheck", () => {
  it("does not flag a clean 50/50", () => {
    const r = srmCheck([5000, 5010], [50, 50]);
    expect(r.mismatch).toBe(false);
    expect(r.pValue).toBeGreaterThan(0.001);
    expect(r.df).toBe(1);
  });

  it("flags a 50/50 that arrived 60/40 at scale", () => {
    const r = srmCheck([6000, 4000], [50, 50]);
    expect(r.mismatch).toBe(true);
    expect(r.pValue).toBeLessThan(0.001);
    expect(r.chiSquare).toBeCloseTo(400, 6); // (1000^2)/5000 twice
    expect(r.observedSplit[0]).toBeCloseTo(0.6, 10);
  });

  it("does not flag 60/40 when 60/40 is what was asked for", () => {
    const r = srmCheck([6000, 4000], [60, 40]);
    expect(r.mismatch).toBe(false);
    expect(r.chiSquare).toBeCloseTo(0, 10);
  });

  it("reads the split as weights, however it is written", () => {
    const a = srmCheck([6000, 4000], [50, 50]);
    const b = srmCheck([6000, 4000], [1, 1]);
    const c = srmCheck([6000, 4000], [0.5, 0.5]);
    expect(a.chiSquare).toBeCloseTo(b.chiSquare, 10);
    expect(b.chiSquare).toBeCloseTo(c.chiSquare, 10);
  });

  it("handles more than two arms", () => {
    const even = srmCheck([3000, 3000, 3000], [1, 1, 1]);
    expect(even.df).toBe(2);
    expect(even.mismatch).toBe(false);
    const skewed = srmCheck([5000, 2000, 2000], [1, 1, 1]);
    expect(skewed.mismatch).toBe(true);
  });

  it("is tolerant of small samples — noise is not a mismatch", () => {
    // 60/40 on 100 visitors is well within chance; the same ratio at 10,000
    // is not. The test must not fire on the first.
    expect(srmCheck([60, 40], [50, 50]).mismatch).toBe(false);
    expect(srmCheck([6000, 4000], [50, 50]).mismatch).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(() => srmCheck([100], [100])).toThrow(RangeError);
    expect(() => srmCheck([50, 50], [1, 1, 1])).toThrow(RangeError);
    expect(() => srmCheck([0, 0], [1, 1])).toThrow(RangeError);
  });
});

describe("confidenceIntervalDiff", () => {
  it("brackets the observed difference", () => {
    const ci = confidenceIntervalDiff({ successes: 500, trials: 5000 }, { successes: 600, trials: 5000 });
    expect(ci.diff).toBeCloseTo(0.02, 10);
    expect(ci.low).toBeLessThan(ci.diff);
    expect(ci.high).toBeGreaterThan(ci.diff);
  });

  it("excludes zero exactly when the z-test calls it significant", () => {
    const control = { successes: 500, trials: 5000 };
    const variant = { successes: 600, trials: 5000 };
    const ci = confidenceIntervalDiff(control, variant, 0.05);
    const { p } = twoProportionZTest(variant.successes, variant.trials, control.successes, control.trials);
    expect(p).toBeLessThan(0.05);
    expect(ci.low).toBeGreaterThan(0); // interval clears zero, same verdict

    const flat = confidenceIntervalDiff({ successes: 500, trials: 5000 }, { successes: 505, trials: 5000 });
    const flatP = twoProportionZTest(505, 5000, 500, 5000).p;
    expect(flatP).toBeGreaterThan(0.05);
    expect(flat.low).toBeLessThan(0);
    expect(flat.high).toBeGreaterThan(0); // interval spans zero, same verdict
  });

  it("widens as confidence tightens", () => {
    const a = confidenceIntervalDiff({ successes: 500, trials: 5000 }, { successes: 600, trials: 5000 }, 0.05);
    const b = confidenceIntervalDiff({ successes: 500, trials: 5000 }, { successes: 600, trials: 5000 }, 0.01);
    expect(b.high - b.low).toBeGreaterThan(a.high - a.low);
  });
});

describe("probabilityToBeatControl", () => {
  it("is 0.5 when the arms are identical", () => {
    expect(probabilityToBeatControl({ successes: 500, trials: 5000 }, { successes: 500, trials: 5000 }))
      .toBeCloseTo(0.5, 6);
  });

  it("rises with the variant and is symmetric", () => {
    const control = { successes: 500, trials: 5000 };
    const variant = { successes: 600, trials: 5000 };
    const up = probabilityToBeatControl(control, variant);
    const down = probabilityToBeatControl(variant, control);
    expect(up).toBeGreaterThan(0.9);
    expect(up + down).toBeCloseTo(1, 6);
  });

  it("is less certain on less data at the same rates", () => {
    const small = probabilityToBeatControl({ successes: 50, trials: 500 }, { successes: 60, trials: 500 });
    const large = probabilityToBeatControl({ successes: 500, trials: 5000 }, { successes: 600, trials: 5000 });
    expect(large).toBeGreaterThan(small);
  });

  it("falls back to 0.5 with no data rather than throwing", () => {
    expect(probabilityToBeatControl({ successes: 0, trials: 0 }, { successes: 0, trials: 0 })).toBe(0.5);
  });
});
