// ============================================================================
// Wasabi — fold captured purchase counts onto the results VariantRow[].
// ----------------------------------------------------------------------------
// PURE (no I/O): the DB read lives in lib/events.ts (purchaseCountsByVariant);
// the Metabase read lives in lib/metabase.ts (runResults). This module is the
// seam between them — it takes a { variant: count } map (from the local `event`
// table) and the per-arm rows and produces the rows the verdict/registry read,
// so the composition is unit-testable with plain fixtures (mirrors how
// buildVerdict stays pure and is composed at the route). Composed in
// app/api/experiments/[key]/results/route.ts.
//
// WHY this exists: the `purchases` goal metric (lib/seeds.ts) reads
// VariantRow.purchases. That field is NOT in the Metabase payments query — it
// is event-based (the storefront /thank-you `purchase` ping, see #223). So the
// results pipeline has to graft the event counts onto the rows before the
// registry resolves the goal. Two cases:
//   1. Metabase HAS cohort rows (a theme-mapped experiment) → merge the counts
//      onto those rows (mergePurchaseCounts).
//   2. Metabase has NO rows — a split-URL test whose arms map to their own
//      variant value, never a real global-api Theme (GP-603), so the payments
//      query returns nothing — but the arm still captured purchases → build
//      event-only rows so the purchase goal still renders (buildEventOnlyRows).
//
// HONESTY: a 0 is only ever written for an experiment that is ACTUALLY
// receiving purchases (isPurchaseActive — at least one arm has ≥1). For an
// experiment with no purchase wiring at all, `purchases` is left undefined so
// the metric blanks ("—") instead of showing a fabricated 0 on every arm. And
// buildEventOnlyRows returns [] for such an experiment — it never synthesises
// all-zero rows out of nothing, so a Metabase outage on a normal experiment
// still degrades to its empty state rather than a fake all-zero table.
// ============================================================================
import type { RegisteredExperiment } from "./experiments";
import type { VariantRow } from "./verdict";

/** True when the experiment is actually receiving purchase captures — at least
 *  one arm has ≥1. Gates whether a missing arm reads 0 (a real measured zero)
 *  or blank (not purchase-wired), and whether an event-only fallback is built. */
export function isPurchaseActive(counts: Record<string, number>): boolean {
  for (const v of Object.values(counts)) if (v > 0) return true;
  return false;
}

/**
 * Attach the per-variant purchase count to each Metabase-derived row. When the
 * experiment is purchase-active every arm gets a number (a genuinely-zero arm
 * reads 0); otherwise `purchases` is left untouched (undefined → the metric
 * blanks). Returns NEW row objects — never mutates the input.
 */
export function mergePurchaseCounts(
  rows: readonly VariantRow[],
  counts: Record<string, number>,
): VariantRow[] {
  const active = isPurchaseActive(counts);
  return rows.map((r) => {
    if (!active) return { ...r };
    return { ...r, purchases: counts[r.variant] ?? 0 };
  });
}

/**
 * Build event-only rows for an experiment whose Metabase payments query is
 * empty but which IS capturing purchases (the GP-603 split-URL case). One row
 * per arm in the experiment's results order, payment/ads fields zeroed (there
 * genuinely is no cohort revenue/ads data — auth/rebill ratios read 0/0 → the
 * registry resolves them to null → they blank, never a fake rate), and
 * `purchases` populated from the captured counts. Returns [] when the
 * experiment isn't purchase-active, so it never fabricates rows.
 */
export function buildEventOnlyRows(
  experiment: RegisteredExperiment,
  counts: Record<string, number>,
): VariantRow[] {
  if (!isPurchaseActive(counts)) return [];
  return experiment.resultsThemeMap.map(({ variant, themeSlug }) => ({
    variant,
    themeSlug,
    isControl: variant === experiment.controlVariant,
    appsAcquired: 0,
    firstPaid: 0,
    firstFailed: 0,
    authRate: 0,
    rebillOk: 0,
    rebillFail: 0,
    rebillRate: 0,
    revenueGbp: 0,
    revPerAcquired: 0,
    purchases: counts[variant] ?? 0,
  }));
}
