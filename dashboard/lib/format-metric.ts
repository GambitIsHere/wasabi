// ============================================================================
// Wasabi — shared metric-value formatter.
// ----------------------------------------------------------------------------
// ONE place that turns a MetricDef + a raw number into display text, so every
// surface that renders a registry metric (components/LiveResults.tsx's
// WinnersGrid + P&L table, the admin metrics form) honours a metric's own
// unit/decimals identically. Before this file, LiveResults.tsx hand-rolled
// money()/pct()/intl() helpers keyed to a hardcoded 3-metric assumption — the
// exact thing that broke when the registry grew to 6 metrics (a currency
// value rendered with "%" appended; see LiveResults.tsx's header for the
// regression this replaces).
//
// Pure, client-safe: imports only TYPES from lib/metrics-core.ts, so this is
// safe to import from "use client" components (unlike lib/metrics.ts, which
// pulls in lib/db.ts and throws if ever evaluated in a browser bundle).
// ============================================================================
import type { MetricDef } from "./metrics-core";

/** ISO 4217 → symbol, for the currencies this dashboard actually transacts
 *  in. Defaults to £ (GBP, Wasabi's home currency) when a row/experiment
 *  hasn't attached a currency — mirrors the pre-registry LiveResults.tsx
 *  behaviour exactly (same fallback, same three codes). */
const CURRENCY_SYMBOL: Record<string, string> = { GBP: "£", EUR: "€", USD: "$" };

export function currencySymbol(currency?: string): string {
  return (currency && CURRENCY_SYMBOL[currency]) || "£";
}

export interface FormatMetricOptions {
  /** Format as a signed delta: a leading "+" on non-negative values (a
   *  negative value already carries its own "-" from toFixed/toLocaleString),
   *  and — for a "percent" unit specifically — a "pp" (percentage-point)
   *  suffix instead of "%", the house convention for a delta on a rate (see
   *  lib/verdict.ts's pp() narrative helper, same convention). */
  signed?: boolean;
}

/**
 * Render one metric value for display, unit- and decimals-aware:
 *   - percent:   "12.3%"      (or "+1.2pp" / "-7.7pp" when signed)
 *   - currency:  "£1,234.56"  (symbol from `currency`, thousands-separated)
 *   - count:     "1,234"      (thousands-separated, decimals respected)
 *   - ratio:     "0.42"       (plain decimal, no symbol/suffix)
 *
 * `value === null` — metricValue()'s honest "can't resolve this metric on
 * this row" signal — renders as an em dash "—", NEVER "0" or "NaN". This is
 * the ONE formatter every metric-rendering surface uses, so a typo'd or
 * missing unit case can't silently show a currency figure with no symbol or
 * a percent with the wrong scale.
 */
export function formatMetric(
  def: Pick<MetricDef, "unit" | "decimals">,
  value: number | null,
  currency?: string,
  options?: FormatMetricOptions,
): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const signed = options?.signed ?? false;
  const sign = signed && value >= 0 ? "+" : "";
  const decimals = def.decimals;

  switch (def.unit) {
    case "percent":
      return `${sign}${value.toFixed(decimals)}${signed ? "pp" : "%"}`;
    case "currency":
      return `${sign}${currencySymbol(currency)}${value.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}`;
    case "count":
      return `${sign}${value.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}`;
    case "ratio":
      return `${sign}${value.toFixed(decimals)}`;
    default: {
      // Exhaustiveness guard: MetricUnit is a closed union. If a 5th unit is
      // ever added to the registry without a case here, fail loudly in
      // development rather than silently falling through to an unformatted
      // number — the same "never a silent drift" posture as the rest of the
      // registry (see lib/metrics.ts's toMetricDef).
      const exhaustive: never = def.unit;
      return String(exhaustive);
    }
  }
}

/** A relative delta as a signed percentage, independent of the metric's own
 *  unit (e.g. "+21%" / "-4%") — the "(…) vs control" clause next to a
 *  winner's absolute delta in WinnersGrid. */
export function formatRelativeDelta(deltaRel: number): string {
  if (!Number.isFinite(deltaRel)) return "—";
  const pct = deltaRel * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}
