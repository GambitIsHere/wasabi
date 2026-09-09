// ============================================================================
// SampleSizeCalculator — render smoke test.
// ----------------------------------------------------------------------------
// A jsdom-free integration check: renderToStaticMarkup (react-dom is already a
// dep — no new packages, no vitest-config change, so the file stays a plain
// `.ts` that the existing "**/*.test.ts" glob picks up) mounts the client
// widget with its default state and asserts the readout shows EXACTLY what
// lib/ab-stats.ts computes for those inputs. That proves the in-tool wiring —
// component → shared engine → rendered figures — end to end, which the browser
// can't be driven to here (the create page is auth + Neon gated). Interactions
// aren't covered (no DOM events under static markup); the engine's own maths
// is covered exhaustively in lib/ab-stats.test.ts.
// ============================================================================
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SampleSizeCalculator, interpretArms } from "@/components/SampleSizeCalculator";
import { estimateDuration, sampleSizePerArm } from "@/lib/ab-stats";

describe("SampleSizeCalculator", () => {
  const markup = renderToStaticMarkup(createElement(SampleSizeCalculator));

  it("renders the planning card", () => {
    expect(markup).toContain("Sample size");
    expect(markup).toContain("Baseline conversion rate");
    expect(markup).toContain("Minimum detectable effect");
  });

  it("shows the engine's numbers for the default inputs", () => {
    // Mirror the component's default state (baseline 5%, +10% relative MDE,
    // 95% confidence, 80% power, two-sided, 2 arms, 1000/day, 100% allocation).
    const nPerArm = sampleSizePerArm({
      baselineRate: 0.05,
      mde: 0.1,
      mdeType: "relative",
      alpha: 0.05,
      power: 0.8,
      sides: 2,
    });
    const total = nPerArm * 2;
    const dur = estimateDuration({ nPerArm, variants: 2, dailyTraffic: 1000, allocation: 1 });

    expect(Number.isFinite(nPerArm)).toBe(true);
    expect(markup).toContain(nPerArm.toLocaleString("en-GB"));
    expect(markup).toContain(total.toLocaleString("en-GB"));
    expect(markup).toContain(`~${dur.weeks} wk`);
    // The default arms field (2) is clean, so the readout labels it plainly.
    expect(markup).toContain("Total (2 arms)");
  });
});

// ---------------------------------------------------------------------------
// interpretArms — the visible arms-input clamp (fix: no silent coercion)
// ---------------------------------------------------------------------------
describe("interpretArms", () => {
  it("passes a clean whole number ≥ 2 through with no note", () => {
    expect(interpretArms("2")).toEqual({ count: 2, note: null });
    expect(interpretArms("3")).toEqual({ count: 3, note: null });
    expect(interpretArms("10")).toEqual({ count: 10, note: null });
  });

  it("clamps below-minimum values to 2 and says so", () => {
    for (const t of ["1", "0", "-4"]) {
      const r = interpretArms(t);
      expect(r.count).toBe(2);
      expect(r.note).not.toBeNull();
    }
  });

  it("clamps blank / non-numeric input to 2 and says so", () => {
    for (const t of ["", "   ", "abc"]) {
      const r = interpretArms(t);
      expect(r.count).toBe(2);
      expect(r.note).not.toBeNull();
    }
  });

  it("rounds a decimal to a whole arm count and says so (5.7 → 6, not a silent 2)", () => {
    const r = interpretArms("5.7");
    expect(r.count).toBe(6);
    expect(r.note).not.toBeNull();
    // The old behaviour rounded silently; the count the readout uses is surfaced.
    expect(r.note).toContain("6");
  });
});
