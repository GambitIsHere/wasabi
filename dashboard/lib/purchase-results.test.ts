// ============================================================================
// purchase-results.ts — the pure seam that folds captured `purchase` event
// counts onto the results VariantRow[]. Proves the two paths (merge onto
// Metabase rows / build event-only rows), the honesty rules (a 0 only for a
// purchase-active experiment; blank otherwise; never synthesise rows from
// nothing), and — the load-bearing check — that the `purchases` GOAL metric
// actually resolves off the field these functions populate, and that
// buildVerdict then picks the arm with the most captured purchases.
// ============================================================================
import { describe, expect, it } from "vitest";
import {
  buildEventOnlyRows,
  isPurchaseActive,
  mergePurchaseCounts,
} from "@/lib/purchase-results";
import { metricValue, type MetricDef } from "@/lib/metrics";
import { SEED_METRICS } from "@/lib/seeds";
import { buildVerdict, type VariantRow } from "@/lib/verdict";
import type { RegisteredExperiment } from "@/lib/experiments";

/** The real `purchases` seed metric, adapted to a MetricDef (as the DB row
 *  mapper would produce it) so we exercise the SHIPPED definition, not a
 *  hand-written stand-in. */
function purchasesDef(): MetricDef {
  const seed = SEED_METRICS.find((m) => m.key === "purchases")!;
  return {
    key: seed.key,
    label: seed.label,
    description: seed.description ?? "",
    kind: seed.kind,
    direction: seed.direction,
    unit: seed.unit,
    numeratorField: (seed.numeratorField ?? null) as MetricDef["numeratorField"],
    denominatorField: seed.denominatorField ?? null,
    valueField: (seed.valueField ?? null) as MetricDef["valueField"],
    decimals: seed.decimals ?? 0,
    isGoal: seed.isGoal ?? false,
    showInTable: seed.showInTable ?? true,
    displayOrder: seed.displayOrder ?? 100,
    enabled: seed.enabled ?? true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A minimal Metabase-shaped row (payment fields present) for the merge path. */
function metabaseRow(overrides: Partial<VariantRow> = {}): VariantRow {
  return {
    variant: "control",
    themeSlug: "control",
    isControl: true,
    appsAcquired: 100,
    firstPaid: 50,
    firstFailed: 10,
    authRate: 83.3,
    rebillOk: 20,
    rebillFail: 5,
    rebillRate: 80,
    revenueGbp: 500,
    revPerAcquired: 5,
    ...overrides,
  };
}

/** A GP-603-shaped experiment: five arms whose theme slug IS the variant value. */
function gp603(): RegisteredExperiment {
  const arms = ["control", "static", "rotate", "marquee", "ticker"];
  return {
    flag: { key: "gp-603" },
    name: "GP-603",
    description: "",
    themeMap: {},
    controlVariant: "control",
    startDate: "2026-09-07",
    youtrackTicket: "GP-603",
    resultsThemeMap: arms.map((v) => ({ variant: v, themeSlug: v })),
  } as unknown as RegisteredExperiment;
}

describe("isPurchaseActive", () => {
  it("is false for an empty map and an all-zero map", () => {
    expect(isPurchaseActive({})).toBe(false);
    expect(isPurchaseActive({ control: 0, static: 0 })).toBe(false);
  });

  it("is true as soon as one arm has a purchase", () => {
    expect(isPurchaseActive({ control: 0, static: 1 })).toBe(true);
  });
});

describe("mergePurchaseCounts", () => {
  it("attaches per-arm counts when the experiment is purchase-active, 0 for a missing arm", () => {
    const rows = [
      metabaseRow({ variant: "control", isControl: true }),
      metabaseRow({ variant: "static", isControl: false }),
    ];
    const merged = mergePurchaseCounts(rows, { control: 7 }); // static has none
    expect(merged.find((r) => r.variant === "control")!.purchases).toBe(7);
    // A genuinely-zero arm of a purchase-active experiment reads 0 (a real
    // measured zero), not blank.
    expect(merged.find((r) => r.variant === "static")!.purchases).toBe(0);
  });

  it("leaves purchases undefined (blank, not a fake 0) when no arm has any purchases", () => {
    const rows = [metabaseRow({ variant: "control" })];
    const merged = mergePurchaseCounts(rows, {});
    expect(merged[0].purchases).toBeUndefined();
  });

  it("never mutates the input rows", () => {
    const rows = [metabaseRow({ variant: "control" })];
    mergePurchaseCounts(rows, { control: 3 });
    expect(rows[0].purchases).toBeUndefined();
  });
});

describe("buildEventOnlyRows", () => {
  it("returns [] when the experiment isn't purchase-active — never fabricates all-zero rows", () => {
    expect(buildEventOnlyRows(gp603(), {})).toEqual([]);
    expect(buildEventOnlyRows(gp603(), { control: 0 })).toEqual([]);
  });

  it("builds one row per arm with payment fields zeroed and purchases populated", () => {
    const counts = { control: 4, static: 11, rotate: 2 }; // marquee/ticker none
    const rows = buildEventOnlyRows(gp603(), counts);
    expect(rows.map((r) => r.variant)).toEqual([
      "control",
      "static",
      "rotate",
      "marquee",
      "ticker",
    ]);
    expect(rows.filter((r) => r.isControl).map((r) => r.variant)).toEqual(["control"]);
    expect(rows.find((r) => r.variant === "static")!.purchases).toBe(11);
    expect(rows.find((r) => r.variant === "marquee")!.purchases).toBe(0);
    // Payment fields are honest zeros; the ratio metrics then read 0/0 → null.
    const control = rows.find((r) => r.isControl)!;
    expect(control.revPerAcquired).toBe(0);
    expect(control.firstPaid).toBe(0);
  });

  it("the purchases GOAL metric resolves the captured count off the built row", () => {
    const rows = buildEventOnlyRows(gp603(), { control: 4, static: 11 });
    const def = purchasesDef();
    expect(metricValue(def, rows.find((r) => r.variant === "static")!)).toBe(11);
    expect(metricValue(def, rows.find((r) => r.variant === "control")!)).toBe(4);
  });
});

describe("integration — buildVerdict picks the arm with the most captured purchases", () => {
  it("the purchase winner is the highest-count arm, read from event data alone", () => {
    const rows = buildEventOnlyRows(gp603(), {
      control: 4,
      static: 11,
      rotate: 9,
      marquee: 2,
      ticker: 6,
    });
    const verdict = buildVerdict(rows, [purchasesDef()]);
    const winner = verdict.winners.find((w) => w.metric === "purchases")!;
    expect(winner.winner).toBe("static");
    expect(winner.winnerValue).toBe(11);
    expect(winner.controlValue).toBe(4);
    expect(winner.delta).toBe(7);
  });
});
