// ============================================================================
// Wasabi — the metric registry's PURE core (types, validation, value resolution).
// ----------------------------------------------------------------------------
// Split out of lib/metrics.ts (this batch) for the same reason lib/mgmt.ts is
// split from lib/store.ts: lib/metrics.ts imports lib/db.ts (Neon), which
// throws if it's ever evaluated in a browser bundle (see its `typeof window`
// guard) — so nothing in THIS file may import "./db". That matters concretely
// this batch: components/LiveResults.tsx (a "use client" component) and the
// admin metrics form both need metricValue()/isImprovement()/validateMetricDef()
// at runtime, not just MetricDef's TYPE — a plain `import type` isn't enough.
//
// lib/metrics.ts re-exports everything here (`export * from "./metrics-core"`)
// so every EXISTING server-side caller keeps working unchanged; new client code
// imports straight from this file so it never pulls in "./db" transitively.
// ============================================================================
import type { VariantRow } from "./verdict";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a metric's value is derived from a VariantRow. */
export type MetricKind = "ratio" | "continuous" | "sum";

/** Which way is "good" for a metric — used to pick winners and to judge
 *  whether a delta is an improvement. THE fix this batch makes: this used to
 *  be a single-member union ("higher_is_better" only), silently assuming every
 *  metric is bigger-is-better. A lower-is-better metric (churn rate, refund
 *  rate, CAC) would have had its WORST-performing arm declared the winner. */
export type Direction = "higher_is_better" | "lower_is_better";

/** Display unit — governs formatting AND (for "percent") whether a ratio's
 *  raw 0..1 fraction is scaled ×100 before it's returned (see metricValue). */
export type MetricUnit = "percent" | "currency" | "count" | "ratio";

/**
 * The VariantRow fields a metric is allowed to reference, as numerator,
 * denominator (or a "+"-joined sum of these), or value field. Exported so the
 * admin UI can offer a dropdown instead of free text — typing a field name
 * wrong would otherwise silently produce a dead metric (metricValue would
 * return null for every row, and nobody would notice until someone asked why
 * a metric's chart is empty).
 *
 * Deliberately hand-listed rather than `keyof VariantRow`: VariantRow also has
 * non-numeric fields (variant, themeSlug, isControl, currency) that must NOT
 * be selectable here. The `satisfies` below is a compile-time tripwire — if a
 * listed name stops being a real VariantRow key (e.g. a rename in verdict.ts),
 * this file fails to compile instead of silently drifting out of sync. It does
 * NOT verify "numeric" (TS can't express "just the number-typed keys" cheaply
 * against optional properties without more machinery than this earns) — keep
 * this list numeric-only by hand; every entry was checked against VariantRow's
 * interface when this list was written.
 */
export const VARIANT_ROW_NUMERIC_FIELDS = [
  "appsAcquired",
  "firstPaid",
  "firstFailed",
  "authRate",
  "rebillOk",
  "rebillFail",
  "rebillRate",
  "revenueGbp",
  "revPerAcquired",
  "adClicks",
  "adConversions",
  "refundsGbp",
  "chargebacksGbp",
  "netRevenueGbp",
  "breakEvenCacGbp",
  "revenueNative",
  "revPerAcquiredNative",
] as const satisfies readonly (keyof VariantRow)[];

export type VariantRowNumericField = (typeof VARIANT_ROW_NUMERIC_FIELDS)[number];

/**
 * A metric definition, as stored + resolved. The single source of truth for
 * "what does this metric mean and how do I compute it" — lib/verdict.ts reads
 * an array of these instead of hardcoding metric names.
 */
export interface MetricDef {
  key: string;
  label: string;
  /** 1-2 sentence explanation; "" when not set. */
  description: string;
  kind: MetricKind;
  direction: Direction;
  unit: MetricUnit;
  /** ratio only: the VariantRow field to use as the numerator (successes). */
  numeratorField: VariantRowNumericField | null;
  /** ratio only: a single VariantRow field, or several joined with "+" (e.g.
   *  "firstPaid+firstFailed") — the ONLY expression syntax supported (strict
   *  allow-listed summing, never a general evaluator). See
   *  parseDenominatorFields. */
  denominatorField: string | null;
  /** continuous/sum only: the VariantRow field to read directly. */
  valueField: VariantRowNumericField | null;
  decimals: number;
  /** Selectable as an experiment's goal metric (mirrors lib/mgmt.ts's
   *  goal-metric dropdown, which reads metrics where isGoal is true). */
  isGoal: boolean;
  /** Show as a column in the registry-driven results table. */
  showInTable: boolean;
  displayOrder: number;
  enabled: boolean;
  createdAt: string;
}

/** The create/update contract — mirrors lib/mgmt.ts's ExperimentInput split
 *  (loose enough for a form/JSON boundary, validated by validateMetricDef
 *  before anything touches the DB). `key` is immutable on update: updateMetric
 *  takes the lookup key as its own parameter and ignores input.key, exactly
 *  like lib/store.ts's updateExperiment. */
export interface MetricInput {
  key: string;
  label: string;
  description?: string;
  kind: MetricKind;
  direction: Direction;
  unit: MetricUnit;
  numeratorField?: string | null;
  denominatorField?: string | null;
  valueField?: string | null;
  decimals?: number;
  isGoal?: boolean;
  showInTable?: boolean;
  displayOrder?: number;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Reference data + validation (mirrors lib/mgmt.ts's validateInput shape:
// single error string or null, checked top-to-bottom, first failure wins).
// Exported (not module-private) so lib/metrics.ts's DB-row mapper AND the
// admin form's dropdowns share exactly one definition of "what's allowed" —
// never two lists that can drift apart.
// ---------------------------------------------------------------------------

export const METRIC_KINDS: readonly MetricKind[] = ["ratio", "continuous", "sum"];
export const DIRECTIONS: readonly Direction[] = ["higher_is_better", "lower_is_better"];
export const METRIC_UNITS: readonly MetricUnit[] = ["percent", "currency", "count", "ratio"];

/** Lower-case letters, digits, underscores; must start with a letter. Metric
 *  keys are snake_case (auth_rate, rev_per_acquired) — distinct from
 *  experiment/variant keys, which are kebab-case (see mgmt.ts's KEY_RE). */
export const METRIC_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const LABEL_MAX = 80;
/** Mirrors lib/mgmt.ts's DESCRIPTION_MAX — same card-layout reasoning. */
export const DESCRIPTION_MAX = 400;
export const DECIMALS_MAX = 6;

export function isVariantRowNumericField(v: string): v is VariantRowNumericField {
  return (VARIANT_ROW_NUMERIC_FIELDS as readonly string[]).includes(v);
}

/**
 * Strict allow-listed parser for a ratio metric's denominator: either ONE
 * known VariantRow numeric field ("rebillOk") or several joined with "+"
 * ("firstPaid+firstFailed" — auth_rate's real denominator, paid+failed
 * attempts). Deliberately NOT a general expression evaluator: no other
 * operators, no nesting, no numbers, no arbitrary code — just literal "+"
 * splitting and an allow-list membership check per segment. Returns null for
 * an empty/missing expression or if ANY segment isn't a known field, so a
 * typo fails validation instead of silently producing a dead metric.
 */
export function parseDenominatorFields(
  expr: string | null | undefined,
): VariantRowNumericField[] | null {
  if (expr === null || expr === undefined) return null;
  const trimmed = expr.trim();
  if (trimmed.length === 0) return null;

  const parts = trimmed.split("+").map((p) => p.trim());
  const fields: VariantRowNumericField[] = [];
  for (const part of parts) {
    if (part.length === 0 || !isVariantRowNumericField(part)) return null;
    fields.push(part);
  }
  return fields;
}

/**
 * Validate a MetricInput against every business rule. Used by BOTH
 * createMetric/updateMetric (authoritative, lib/metrics.ts) and the admin
 * form (live, to gate submit) — same split as mgmt.ts's validateInput.
 */
export function validateMetricDef(input: MetricInput): string | null {
  const key = (input.key ?? "").trim();
  if (!METRIC_KEY_RE.test(key)) {
    return `Metric key must be lower-case letters, numbers and underscores, starting with a letter (e.g. auth_rate) — got "${input.key}".`;
  }
  if (!input.label || input.label.trim().length === 0) {
    return "Label is required.";
  }
  if (input.label.trim().length > LABEL_MAX) {
    return `Label must be ${LABEL_MAX} characters or fewer.`;
  }
  if (input.description !== undefined && input.description.length > DESCRIPTION_MAX) {
    return `Description must be ${DESCRIPTION_MAX} characters or fewer (currently ${input.description.length}).`;
  }
  if (!METRIC_KINDS.includes(input.kind)) {
    return `Kind must be one of: ${METRIC_KINDS.join(", ")}.`;
  }
  if (!DIRECTIONS.includes(input.direction)) {
    return `Direction must be one of: ${DIRECTIONS.join(", ")}.`;
  }
  if (!METRIC_UNITS.includes(input.unit)) {
    return `Unit must be one of: ${METRIC_UNITS.join(", ")}.`;
  }
  if (
    input.decimals !== undefined &&
    (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > DECIMALS_MAX)
  ) {
    return `Decimals must be a whole number between 0 and ${DECIMALS_MAX}.`;
  }
  if (input.displayOrder !== undefined && !Number.isInteger(input.displayOrder)) {
    return "Display order must be a whole number.";
  }

  if (input.kind === "ratio") {
    const num = (input.numeratorField ?? "").trim();
    if (!isVariantRowNumericField(num)) {
      return `Numerator field must be one of: ${VARIANT_ROW_NUMERIC_FIELDS.join(", ")} — got "${input.numeratorField ?? ""}".`;
    }
    if (!parseDenominatorFields(input.denominatorField)) {
      return `Denominator field must be a known field, or known fields joined with "+" (e.g. firstPaid+firstFailed) — got "${input.denominatorField ?? ""}".`;
    }
  } else {
    // continuous | sum both read a single value field directly.
    const val = (input.valueField ?? "").trim();
    if (!isVariantRowNumericField(val)) {
      return `Value field must be one of: ${VARIANT_ROW_NUMERIC_FIELDS.join(", ")} — got "${input.valueField ?? ""}".`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Direction-aware interpretation — the other half of the Direction fix.
// Winner selection (buildWinner in verdict.ts) picks max/min by direction;
// THIS is the "is that delta actually good?" judgement callers need so a drop
// on a lower_is_better metric reads as an improvement, not a loss. `delta`
// stays raw arithmetic (winner|variant − control) — this never flips its
// sign, only how it's read.
// ---------------------------------------------------------------------------

export function isImprovement(direction: Direction, delta: number): boolean {
  return direction === "higher_is_better" ? delta > 0 : delta < 0;
}

// ---------------------------------------------------------------------------
// Value resolution — the pure functions lib/verdict.ts builds winners and
// significance tests from, and components/LiveResults.tsx reads per-row,
// per-metric table cells from.
// ---------------------------------------------------------------------------

/** Read one numeric field off a row; null when the field is unset (VariantRow
 *  marks several fields optional for older-caller / test-fixture compat) or
 *  not actually a finite number. Never NaN/undefined leaks out. */
function readVariantField(row: VariantRow, field: VariantRowNumericField | null): number | null {
  if (field === null) return null;
  const v = row[field];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Sum of a ratio metric's denominator field(s) on one row. Null propagates:
 *  if ANY component field is missing, the whole denominator is unresolvable —
 *  never partially summed. */
function sumDenominatorFields(row: VariantRow, expr: string | null): number | null {
  const fields = parseDenominatorFields(expr);
  if (!fields) return null;
  let sum = 0;
  for (const f of fields) {
    const v = readVariantField(row, f);
    if (v === null) return null;
    sum += v;
  }
  return sum;
}

/**
 * A ratio metric's raw numerator/denominator counts on one row (e.g.
 * firstPaid, firstPaid+firstFailed) — the RAW counts, not yet divided or
 * percent-scaled. This is what lib/verdict.ts's two-proportion z-test needs
 * (successes/trials); metricValue() below builds on it for the divided,
 * display-scaled value. Null when the metric isn't "ratio" or any referenced
 * field is missing on this row — never a fabricated 0.
 */
export function ratioComponents(
  def: MetricDef,
  row: VariantRow,
): { numerator: number; denominator: number } | null {
  if (def.kind !== "ratio") return null;
  const numerator = readVariantField(row, def.numeratorField);
  const denominator = sumDenominatorFields(row, def.denominatorField);
  if (numerator === null || denominator === null) return null;
  return { numerator, denominator };
}

/**
 * Resolve a metric's value off one VariantRow, in its natural display unit:
 *   - ratio:              numerator / denominator, ×100 when unit="percent"
 *                          (parity with the pre-registry VariantRow.authRate /
 *                          .rebillRate fields, which were already 0-100 scale
 *                          — see lib/verdict.ts's header for why that matters)
 *                          — left as a 0..1 fraction for unit="ratio".
 *   - continuous | sum:    the value field, read directly.
 *
 * Divide-by-zero and any missing referenced field both return null — NEVER
 * NaN or Infinity, and never a fabricated 0. Callers (buildWinner in
 * verdict.ts, PerVariantTable in LiveResults.tsx) must skip/blank a metric
 * entirely when its value is null for a row, rather than rendering it as
 * though the metric were zero.
 */
export function metricValue(def: MetricDef, row: VariantRow): number | null {
  if (def.kind === "ratio") {
    const comp = ratioComponents(def, row);
    if (!comp || comp.denominator === 0) return null;
    const raw = comp.numerator / comp.denominator;
    return def.unit === "percent" ? raw * 100 : raw;
  }
  // continuous | sum
  return readVariantField(row, def.valueField);
}
