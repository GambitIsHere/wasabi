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
import { SampleSizeCalculator } from "@/components/SampleSizeCalculator";
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
  });
});
