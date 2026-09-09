// ============================================================================
// The window line under the SRM panel.
// ----------------------------------------------------------------------------
// retentionDays is the CEILING, not the coverage. Printing "the last 7 days"
// under a count gathered over four hours overstates what the early warning is
// based on — the one thing an early warning must never do.
//
// describeWindow is imported from lib/assignment-split — the same module the
// panel renders with — so these tests pin the shipped string, not a copy.
// ============================================================================
import { describe, it, expect } from "vitest";
// The REAL helper the panel renders with — imported, never re-typed here.
import { describeWindow, type SrmWindow as Win } from "./assignment-split";

const base: Win = {
  oldestTs: "2026-09-02T08:00:00.000Z",
  newestTs: "2026-09-05T17:30:00.000Z",
  retentionDays: 7,
  capped: false,
};

// Month abbreviations are ICU data and differ across Node builds ("Sep" vs
// "Sept"), so derive the expected day strings from the same formatter rather
// than hardcoding them. What is under test is the RULE — real span vs the
// retention ceiling, single-day collapse, capped wording — not CLDR.
const day = (ts: string) =>
  new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

describe("describeWindow", () => {
  it("reports the real span, not the retention ceiling", () => {
    const out = describeWindow(base);
    expect(out).toBe(`from ${day(base.oldestTs!)} to ${day(base.newestTs!)}`);
    expect(out).not.toContain("7 days");
  });

  it("collapses a single-day window to 'on <date>' rather than a false range", () => {
    const out = describeWindow({ ...base, oldestTs: "2026-09-05T01:00:00.000Z" });
    expect(out).toBe(`on ${day(base.newestTs!)}`);
    expect(out).not.toContain(" to ");
  });

  it("falls back to the retention ceiling only when there is no timestamp", () => {
    expect(describeWindow({ ...base, oldestTs: null, newestTs: null })).toBe(
      "over the last 7 days",
    );
  });

  it("still falls back when only one end of the span is known", () => {
    expect(describeWindow({ ...base, oldestTs: null })).toBe(
      "over the last 7 days",
    );
    expect(describeWindow({ ...base, newestTs: null })).toBe(
      "over the last 7 days",
    );
  });

  it("says a capped window is SHORTER than retention, never equal to it", () => {
    const out = describeWindow({ ...base, capped: true });
    expect(out).toContain(`from ${day(base.oldestTs!)} to ${day(base.newestTs!)}`);
    expect(out).toContain("shorter than the 7-day retention");
  });

  it("does not crash on an unparseable timestamp", () => {
    expect(() => describeWindow({ ...base, oldestTs: "not-a-date" })).not.toThrow();
  });
});
