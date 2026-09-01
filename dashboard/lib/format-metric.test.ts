// ============================================================================
// format-metric.ts — behavioural tests for the shared metric-value formatter.
// ----------------------------------------------------------------------------
// One block per MetricUnit (percent/currency/count/ratio), covering: plain
// formatting, decimals honoured, signed-delta mode, and the null/non-finite
// → "—" guard that IS the regression this formatter exists to prevent (see
// components/LiveResults.tsx's header — a currency value rendered with "%"
// appended before this file existed). Plus formatRelativeDelta in isolation.
// ============================================================================
import { describe, expect, it } from "vitest";
import { currencySymbol, formatMetric, formatRelativeDelta } from "@/lib/format-metric";

describe("formatMetric — null / non-finite handling", () => {
  it("renders null as an em dash, never 0 or NaN", () => {
    expect(formatMetric({ unit: "percent", decimals: 1 }, null)).toBe("—");
    expect(formatMetric({ unit: "currency", decimals: 2 }, null)).toBe("—");
    expect(formatMetric({ unit: "count", decimals: 0 }, null)).toBe("—");
    expect(formatMetric({ unit: "ratio", decimals: 2 }, null)).toBe("—");
  });

  it("renders NaN and Infinity as an em dash too, defensively (metricValue never actually returns these)", () => {
    expect(formatMetric({ unit: "percent", decimals: 1 }, NaN)).toBe("—");
    expect(formatMetric({ unit: "currency", decimals: 2 }, Infinity)).toBe("—");
    expect(formatMetric({ unit: "count", decimals: 0 }, -Infinity)).toBe("—");
  });

  it("treats an explicit 0 as a real value, not a missing one", () => {
    expect(formatMetric({ unit: "percent", decimals: 1 }, 0)).toBe("0.0%");
    expect(formatMetric({ unit: "count", decimals: 0 }, 0)).toBe("0");
  });
});

describe("formatMetric — percent", () => {
  it("formats to the metric's own decimals, with a % suffix", () => {
    expect(formatMetric({ unit: "percent", decimals: 1 }, 54.632)).toBe("54.6%");
    expect(formatMetric({ unit: "percent", decimals: 0 }, 54.632)).toBe("55%");
    expect(formatMetric({ unit: "percent", decimals: 3 }, 54.632)).toBe("54.632%");
  });

  it("signed mode: leading + on non-negative, and a pp (percentage-point) suffix instead of %", () => {
    expect(formatMetric({ unit: "percent", decimals: 1 }, 22.9, undefined, { signed: true })).toBe(
      "+22.9pp",
    );
    expect(formatMetric({ unit: "percent", decimals: 1 }, -7.7, undefined, { signed: true })).toBe(
      "-7.7pp",
    );
    expect(formatMetric({ unit: "percent", decimals: 1 }, 0, undefined, { signed: true })).toBe(
      "+0.0pp",
    );
  });
});

describe("formatMetric — currency", () => {
  it("prefixes the currency symbol and thousands-separates", () => {
    expect(formatMetric({ unit: "currency", decimals: 2 }, 950903.46, "GBP")).toBe("£950,903.46");
    expect(formatMetric({ unit: "currency", decimals: 2 }, 12.5, "EUR")).toBe("€12.50");
    expect(formatMetric({ unit: "currency", decimals: 2 }, 12.5, "USD")).toBe("$12.50");
  });

  it("defaults to £ (GBP) when no currency, or an unrecognised one, is given", () => {
    expect(formatMetric({ unit: "currency", decimals: 2 }, 12.5)).toBe("£12.50");
    expect(formatMetric({ unit: "currency", decimals: 2 }, 12.5, "JPY")).toBe("£12.50");
  });

  it("respects a non-default decimals count", () => {
    expect(formatMetric({ unit: "currency", decimals: 0 }, 950903.46, "GBP")).toBe("£950,903");
  });

  it("signed mode: leading + on non-negative, symbol still honoured", () => {
    expect(formatMetric({ unit: "currency", decimals: 2 }, 123.45, "EUR", { signed: true })).toBe(
      "+€123.45",
    );
    expect(formatMetric({ unit: "currency", decimals: 2 }, -50.25, "GBP", { signed: true })).toBe(
      "£-50.25",
    );
  });
});

describe("formatMetric — count", () => {
  it("thousands-separates and respects decimals (default 0 for a whole count)", () => {
    expect(formatMetric({ unit: "count", decimals: 0 }, 12345)).toBe("12,345");
  });

  it("signed mode adds a leading + with no unit suffix", () => {
    expect(formatMetric({ unit: "count", decimals: 0 }, 150, undefined, { signed: true })).toBe(
      "+150",
    );
    expect(formatMetric({ unit: "count", decimals: 0 }, -30, undefined, { signed: true })).toBe(
      "-30",
    );
  });
});

describe("formatMetric — ratio", () => {
  it("renders a plain decimal — no symbol, no suffix", () => {
    expect(formatMetric({ unit: "ratio", decimals: 2 }, 0.4231)).toBe("0.42");
    expect(formatMetric({ unit: "ratio", decimals: 0 }, 0.4231)).toBe("0");
  });

  it("signed mode adds a leading + with no suffix", () => {
    expect(formatMetric({ unit: "ratio", decimals: 2 }, 0.42, undefined, { signed: true })).toBe(
      "+0.42",
    );
  });
});

describe("currencySymbol", () => {
  it("maps the three transacted currencies", () => {
    expect(currencySymbol("GBP")).toBe("£");
    expect(currencySymbol("EUR")).toBe("€");
    expect(currencySymbol("USD")).toBe("$");
  });

  it("defaults to £ for undefined or an unknown code", () => {
    expect(currencySymbol(undefined)).toBe("£");
    expect(currencySymbol("XYZ")).toBe("£");
  });
});

describe("formatRelativeDelta", () => {
  it("formats a positive relative delta with a leading + and rounds to a whole percent", () => {
    expect(formatRelativeDelta(0.209)).toBe("+21%");
  });

  it("formats a negative relative delta with its own -", () => {
    expect(formatRelativeDelta(-0.04)).toBe("-4%");
  });

  it("treats exactly zero as a non-negative (+0%), matching the sign convention used elsewhere", () => {
    expect(formatRelativeDelta(0)).toBe("+0%");
  });

  it("renders a non-finite delta as an em dash rather than crashing", () => {
    expect(formatRelativeDelta(NaN)).toBe("—");
    expect(formatRelativeDelta(Infinity)).toBe("—");
  });
});
