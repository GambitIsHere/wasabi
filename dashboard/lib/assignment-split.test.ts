// ============================================================================
// The SRM read on the results page — the arm-alignment and windowing rules.
// ----------------------------------------------------------------------------
// assignmentSplitForExperiment itself is a SQL read and is covered by the route
// behaviour rather than mocked here. What these tests pin is the logic applied
// on top of it, which is where the reasoning lives: aligning observed counts to
// the DECLARED arms, keeping never-assigned arms visible, and feeding srmCheck
// a split that lines up arm-for-arm.
//
// Both helpers are IMPORTED from lib/assignment-split — the same module the
// route and LiveResults import. An earlier draft re-declared them here, which
// meant these tests could pass while the shipped path changed underneath.
// ============================================================================
import { describe, it, expect } from "vitest";
import { srmCheck } from "./ab-stats";
// The REAL implementations the route and the component call — imported, not
// re-typed here, so a change to the shipped code path cannot leave these green.
import { alignArmsToDeclared as alignArms, isAA } from "./assignment-split";

const twoArm = [
  { key: "a", rolloutPercentage: 50 },
  { key: "b", rolloutPercentage: 50 },
];
const fiveArm = ["control", "static", "rotate", "marquee", "ticker"].map((k) => ({
  key: k,
  rolloutPercentage: 20,
}));

describe("arm alignment before the SRM check", () => {
  it("keeps an arm that has received nothing, as a zero", () => {
    // The dangerous failure is an arm getting NO traffic. If it were dropped
    // for being absent from the query result, the split of the remaining arms
    // could look perfect while one arm was dark.
    const arms = alignArms(twoArm, [{ variant: "a", visitors: 5000 }]);
    expect(arms).toHaveLength(2);
    expect(arms[1]).toEqual({ variant: "b", visitors: 0, weight: 50 });
    const srm = srmCheck(arms.map((a) => a.visitors), arms.map((a) => a.weight));
    expect(srm.mismatch).toBe(true);
  });

  it("orders observed counts to match the declared arms, not the query order", () => {
    // The query returns rows ordered by variant name; the expected split is in
    // declaration order. Zipping them positionally without aligning would
    // compare the wrong arm against the wrong weight.
    const declared = [
      { key: "control", rolloutPercentage: 80 },
      { key: "variant", rolloutPercentage: 20 },
    ];
    const observed = [
      { variant: "variant", visitors: 2000 },
      { variant: "control", visitors: 8000 },
    ];
    const arms = alignArms(declared, observed);
    expect(arms.map((a) => a.variant)).toEqual(["control", "variant"]);
    expect(arms.map((a) => a.visitors)).toEqual([8000, 2000]);
    const srm = srmCheck(arms.map((a) => a.visitors), arms.map((a) => a.weight));
    expect(srm.mismatch).toBe(false); // 80/20 observed against 80/20 expected
  });

  it("flags an uneven split that a positional zip would have called clean", () => {
    const declared = [
      { key: "control", rolloutPercentage: 80 },
      { key: "variant", rolloutPercentage: 20 },
    ];
    // Alphabetical query order puts "variant" first; the counts are actually
    // reversed against the weights.
    const observed = [
      { variant: "variant", visitors: 8000 },
      { variant: "control", visitors: 2000 },
    ];
    const arms = alignArms(declared, observed);
    const srm = srmCheck(arms.map((a) => a.visitors), arms.map((a) => a.weight));
    expect(srm.mismatch).toBe(true);
  });

  it("ignores an arm the query knows about but the experiment no longer declares", () => {
    // A retired arm still inside the retention window must not be tested
    // against a weight it no longer has.
    const arms = alignArms(twoArm, [
      { variant: "a", visitors: 5000 },
      { variant: "b", visitors: 5000 },
      { variant: "retired", visitors: 900 },
    ]);
    expect(arms.map((a) => a.variant)).toEqual(["a", "b"]);
    const srm = srmCheck(arms.map((a) => a.visitors), arms.map((a) => a.weight));
    expect(srm.mismatch).toBe(false);
  });

  it("handles the five-arm GP-603 shape", () => {
    const observed = [
      { variant: "control", visitors: 2010 },
      { variant: "static", visitors: 1990 },
      { variant: "rotate", visitors: 2005 },
      { variant: "marquee", visitors: 1995 },
      { variant: "ticker", visitors: 2000 },
    ];
    const arms = alignArms(fiveArm, observed);
    const srm = srmCheck(arms.map((a) => a.visitors), arms.map((a) => a.weight));
    expect(srm.mismatch).toBe(false);
    expect(srm.pValue).toBeGreaterThan(0.001);
  });

  it("flags one arm starved in a five-arm split", () => {
    const observed = [
      { variant: "control", visitors: 2500 },
      { variant: "static", visitors: 2500 },
      { variant: "rotate", visitors: 2500 },
      { variant: "marquee", visitors: 2400 },
      { variant: "ticker", visitors: 100 },
    ];
    const arms = alignArms(fiveArm, observed);
    const srm = srmCheck(arms.map((a) => a.visitors), arms.map((a) => a.weight));
    expect(srm.mismatch).toBe(true);
  });

  it("does not fire on ordinary early-traffic noise", () => {
    // The window is rolling and can be small. A 55/45 on 200 visitors is noise
    // and must not raise an alarm on a freshly-started experiment.
    const arms = alignArms(twoArm, [
      { variant: "a", visitors: 110 },
      { variant: "b", visitors: 90 },
    ]);
    const srm = srmCheck(arms.map((a) => a.visitors), arms.map((a) => a.weight));
    expect(srm.mismatch).toBe(false);
  });
});

describe("degenerate input fails soft, so the panel cannot break the page", () => {
  it("returns a non-mismatch when no traffic has arrived at all", () => {
    const srm = srmCheck([0, 0], [50, 50]);
    expect(srm.mismatch).toBe(false);
    expect(srm.pValue).toBe(1);
  });

  it("returns a non-mismatch for a single arm rather than throwing", () => {
    expect(() => srmCheck([100], [100])).not.toThrow();
    expect(srmCheck([100], [100]).mismatch).toBe(false);
  });

  it("returns a non-mismatch when lengths disagree rather than throwing", () => {
    expect(() => srmCheck([50, 50], [1, 1, 1])).not.toThrow();
    expect(srmCheck([50, 50], [1, 1, 1]).mismatch).toBe(false);
  });
});

describe("A/A detection from the results rows", () => {
  it("recognises an A/A by every arm sharing one storefront slug", () => {
    expect(isAA(["tu_lov_uk", "tu_lov_uk"])).toBe(true);
  });

  it("does not call a real experiment an A/A", () => {
    expect(isAA(["tu_lov_uk", "tu_lov_uk_19"])).toBe(false);
    expect(isAA(["control", "static", "rotate", "marquee", "ticker"])).toBe(false);
  });

  it("needs at least two arms", () => {
    expect(isAA(["tu_lov_uk"])).toBe(false);
    expect(isAA([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A/A copy must survive the not-yet-any-assignments state
// ---------------------------------------------------------------------------
describe("A/A verdict is knowable before any assignment lands", () => {
  it("is decided by the arms' slugs, not by whether a split exists yet", () => {
    // The panel early-returns on srm === null. isAA is computed from the
    // results rows, which exist before the first assignment event does — so
    // the A/A warning is available in exactly the state where the page is
    // most likely being read for the first time.
    expect(isAA(["tu_lov_uk", "tu_lov_uk"])).toBe(true);
  });
});
