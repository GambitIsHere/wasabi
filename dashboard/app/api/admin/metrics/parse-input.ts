// Shared JSON-body → MetricInput shape parser for both admin metrics routes
// (create + update). TYPE-shape parsing only ("is this a string", "is this a
// number") — business-rule validation (is this kind/direction/unit value
// actually one of the allowed ones, is the numerator field a real
// VariantRow field, …) is lib/metrics-core.ts's validateMetricDef's job,
// called by the route AFTER this returns a well-typed MetricInput. Keeping
// that check in ONE place (not duplicated here) is the same reasoning
// lib/metrics.ts's own header gives for the registry existing at all.
//
// Mirrors app/api/admin/roadmap/route.ts's local parseBody: fail-closed,
// returns a human-readable reason string instead of throwing on a malformed
// body, so a bad request is a clean 400, never a 500.
import type { MetricInput } from "@/lib/metrics-core";

const OPTIONAL_STRING_OR_NULL_FIELDS = ["numeratorField", "denominatorField", "valueField"] as const;
const OPTIONAL_BOOLEAN_FIELDS = ["isGoal", "showInTable", "enabled"] as const;

export function parseMetricInput(body: unknown): MetricInput | string {
  if (!body || typeof body !== "object") return "Body must be a JSON object.";
  const b = body as Record<string, unknown>;

  if (typeof b.key !== "string" || b.key.trim().length === 0) {
    return "key is required.";
  }
  if (typeof b.label !== "string" || b.label.trim().length === 0) {
    return "label is required.";
  }
  if (typeof b.kind !== "string") return "kind is required.";
  if (typeof b.direction !== "string") return "direction is required.";
  if (typeof b.unit !== "string") return "unit is required.";

  if (b.description !== undefined && typeof b.description !== "string") {
    return "description must be a string.";
  }
  for (const field of OPTIONAL_STRING_OR_NULL_FIELDS) {
    const v = b[field];
    if (v !== undefined && v !== null && typeof v !== "string") {
      return `${field} must be a string or null.`;
    }
  }
  if (b.decimals !== undefined && typeof b.decimals !== "number") {
    return "decimals must be a number.";
  }
  if (b.displayOrder !== undefined && typeof b.displayOrder !== "number") {
    return "displayOrder must be a number.";
  }
  for (const field of OPTIONAL_BOOLEAN_FIELDS) {
    if (b[field] !== undefined && typeof b[field] !== "boolean") {
      return `${field} must be a boolean.`;
    }
  }

  return {
    key: b.key.trim(),
    label: b.label,
    description: typeof b.description === "string" ? b.description : undefined,
    // Membership in the real kind/direction/unit sets is validateMetricDef's
    // job (see this file's header) — these casts just satisfy MetricInput's
    // narrower field types after the `typeof === "string"` checks above.
    kind: b.kind as MetricInput["kind"],
    direction: b.direction as MetricInput["direction"],
    unit: b.unit as MetricInput["unit"],
    numeratorField: b.numeratorField as string | null | undefined,
    denominatorField: b.denominatorField as string | null | undefined,
    valueField: b.valueField as string | null | undefined,
    decimals: typeof b.decimals === "number" ? b.decimals : undefined,
    isGoal: typeof b.isGoal === "boolean" ? b.isGoal : undefined,
    showInTable: typeof b.showInTable === "boolean" ? b.showInTable : undefined,
    displayOrder: typeof b.displayOrder === "number" ? b.displayOrder : undefined,
    enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
  };
}
