// ============================================================================
// Wasabi — the metric registry (data, not code).
// ----------------------------------------------------------------------------
// Before this file, adding one metric meant editing 4 files and ~69 hardcoded
// references (lib/metabase.ts's SQL, lib/verdict.ts's winner/significance
// logic, components/LiveResults.tsx's table columns, lib/mgmt.ts's
// GOAL_METRICS union) because a metric was a TypeScript literal, not a row.
// This module makes a metric a ROW: definition, validation, and CRUD live
// here; lib/verdict.ts reads the registry and computes winners/significance
// generically off it (see metricValue/ratioComponents, re-exported below).
//
// PATTERN: mirrors lib/store.ts (schema-creation + memoised seed-on-empty) and
// lib/engine/handlers.ts (short-TTL cache for the hot read path, uncached
// reads for admin CRUD so edits reflect immediately). Copied deliberately, not
// reinvented — see ensureMetricsReady()/getMetrics() below.
//
// SERVER-ONLY: imports lib/db.ts (Neon Postgres). Never import from a client
// component — go through a server action or a server component. The PURE
// parts of the registry (types, validateMetricDef, metricValue, isImprovement,
// …) live in lib/metrics-core.ts instead, specifically so client components
// (components/LiveResults.tsx's P&L table, the admin metrics form) can import
// them WITHOUT pulling in "./db" — this file re-exports all of them below so
// every existing server-side caller keeps working unchanged.
//
// TENANCY: every read/write in this file funnels through one place
// (getMetrics / listMetricsUncached / createMetric / updateMetric /
// deleteMetric) — never raw SQL in a caller — which is exactly what made
// adding `WHERE project_id = …` (scripts/migrate-tenancy.ts) a one-file
// change here instead of a hunt across callers. See lib/tenant.ts for why a
// metric definition is project-scoped rather than org-scoped.
// ============================================================================
import { getSql, createSchema } from "./db";
import { SEED_METRICS } from "./seeds";
import { DIRECTIONS, METRIC_KINDS, METRIC_UNITS, isVariantRowNumericField, validateMetricDef } from "./metrics-core";
import type { Direction, MetricDef, MetricInput, MetricKind, MetricUnit, VariantRowNumericField } from "./metrics-core";
import { getCurrentProjectId } from "./tenant";

export * from "./metrics-core";

// ---------------------------------------------------------------------------
// DB row shape + mapping
// ---------------------------------------------------------------------------

interface MetricRow {
  key: string;
  label: string;
  description: string | null;
  kind: string;
  direction: string;
  unit: string;
  numerator_field: string | null;
  denominator_field: string | null;
  value_field: string | null;
  decimals: number;
  is_goal: boolean;
  show_in_table: boolean;
  display_order: number;
  enabled: boolean;
  created_at: string;
  project_id: string;
}

function toNumericFieldOrNull(v: string | null): VariantRowNumericField | null {
  return v !== null && isVariantRowNumericField(v) ? v : null;
}

/**
 * Row → domain mapper. Defensive on kind/direction/unit: writes are gated
 * through validateMetricDef (createMetric/updateMetric), so a bad value here
 * would mean either a hand-edited row or a future migration bug — either way,
 * this SKIPS the row (returns null, logs a warning) rather than crashing every
 * caller of getMetrics()/listMetricsUncached(). Mirrors lib/store.ts's
 * per-seed isolation philosophy: one bad row degrades, it doesn't take down
 * the whole registry.
 */
function toMetricDef(row: MetricRow): MetricDef | null {
  if (!(METRIC_KINDS as readonly string[]).includes(row.kind)) {
    console.warn(`[wasabi] metric "${row.key}" has unknown kind "${row.kind}" — skipped`);
    return null;
  }
  if (!(DIRECTIONS as readonly string[]).includes(row.direction)) {
    console.warn(`[wasabi] metric "${row.key}" has unknown direction "${row.direction}" — skipped`);
    return null;
  }
  if (!(METRIC_UNITS as readonly string[]).includes(row.unit)) {
    console.warn(`[wasabi] metric "${row.key}" has unknown unit "${row.unit}" — skipped`);
    return null;
  }
  return {
    key: row.key,
    label: row.label,
    description: row.description ?? "",
    kind: row.kind as MetricKind,
    direction: row.direction as Direction,
    unit: row.unit as MetricUnit,
    numeratorField: toNumericFieldOrNull(row.numerator_field),
    denominatorField: row.denominator_field,
    valueField: toNumericFieldOrNull(row.value_field),
    decimals: row.decimals,
    isGoal: row.is_goal,
    showInTable: row.show_in_table,
    displayOrder: row.display_order,
    enabled: row.enabled,
    createdAt: row.created_at,
  };
}

function normalizeDescription(d: string | undefined): string | null {
  const trimmed = (d ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Seed-once — mirrors lib/store.ts's ensureReady()/initOnce() exactly, scoped
// to the `metric` table. Seeds only when the table is empty (so an admin
// deleting/disabling a seeded metric sticks — a restart never resurrects it).
// SEED_METRICS lives in lib/seeds.ts alongside the experiment SEED, per the
// same "single source of truth for what a fresh deploy looks like" convention.
// ---------------------------------------------------------------------------

/** INSERT with no readiness guard — used ONLY by the seed loop below, which
 *  has already awaited createSchema() itself. Mirrors store.ts's insertRaw()
 *  vs insertExperiment() split: calling the public createMetric() here would
 *  deadlock (it awaits ensureMetricsReady(), which is what's already running). */
async function insertMetricRaw(input: MetricInput): Promise<string> {
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  await sql`
    INSERT INTO metric (
      key, label, description, kind, direction, unit,
      numerator_field, denominator_field, value_field,
      decimals, is_goal, show_in_table, display_order, enabled, project_id
    ) VALUES (
      ${input.key}, ${input.label.trim()}, ${normalizeDescription(input.description)},
      ${input.kind}, ${input.direction}, ${input.unit},
      ${input.numeratorField ?? null}, ${input.denominatorField ?? null}, ${input.valueField ?? null},
      ${input.decimals ?? 1}, ${input.isGoal ?? false}, ${input.showInTable ?? true},
      ${input.displayOrder ?? 100}, ${input.enabled ?? true}, ${projectId}
    )
  `;
  return input.key;
}

let metricsReadyPromise: Promise<void> | null = null;

function ensureMetricsReady(): Promise<void> {
  return (metricsReadyPromise ??= initMetricsOnce());
}

async function initMetricsOnce(): Promise<void> {
  await createSchema();
  const sql = getSql();
  // Scoped to the current tenant's project, same "seed once PER PROJECT"
  // reasoning as lib/store.ts's initOnce — see that function's comment.
  const projectId = await getCurrentProjectId();
  const rows = (await sql`SELECT COUNT(*)::int AS n FROM metric WHERE project_id = ${projectId}`) as unknown as { n: number }[];
  if ((rows[0]?.n ?? 0) > 0) return;
  // Per-seed isolation, same reasoning as store.ts's initOnce: a cold-start
  // race (another instance seeding the same key) fails only that seed.
  for (const seed of SEED_METRICS) {
    try {
      await insertMetricRaw(seed);
    } catch (err) {
      console.warn(
        "[wasabi] metric seed skipped:",
        seed.key,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Reads — cached (hot path) vs uncached (admin), same split as
// lib/engine/handlers.ts's assignmentRegistry() vs lib/store.ts's
// listExperiments()/getExperiment().
// ---------------------------------------------------------------------------

/** Mirrors lib/engine/handlers.ts's REGISTRY_TTL_MS — assignment/results
 *  tolerate a few seconds of staleness; admin edits go through the uncached
 *  reads below so create/edit/enable/disable reflect immediately.
 *
 *  Keyed by projectId (a Map, not a single slot): getCurrentTenant() always
 *  resolves to the same project today, so a single slot would happen to be
 *  correct either way — but keying by tenant now means real per-request
 *  resolution can land later without this cache silently serving one
 *  tenant's metrics to another inside the TTL window. */
const METRICS_TTL_MS = 10_000;
const metricsCache = new Map<string, { metrics: MetricDef[]; expiry: number }>();

function invalidateMetricsCache(): void {
  metricsCache.clear();
}

/** Enabled metrics, display-ordered, short-TTL cached — what buildVerdict()
 *  iterates for every results/verdict computation. */
export async function getMetrics(): Promise<MetricDef[]> {
  const projectId = await getCurrentProjectId();
  const now = Date.now();
  const cached = metricsCache.get(projectId);
  if (cached && cached.expiry > now) return cached.metrics;
  await ensureMetricsReady();
  const sql = getSql();
  const rows = (await sql`
    SELECT * FROM metric WHERE enabled = true AND project_id = ${projectId} ORDER BY display_order ASC, key ASC
  `) as unknown as MetricRow[];
  const metrics = rows.map(toMetricDef).filter((m): m is MetricDef => m !== null);
  metricsCache.set(projectId, { metrics, expiry: now + METRICS_TTL_MS });
  return metrics;
}

/** ALL metrics (including disabled) in the current tenant's project, uncached
 *  — the admin list view. */
export async function listMetricsUncached(): Promise<MetricDef[]> {
  await ensureMetricsReady();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const rows = (await sql`
    SELECT * FROM metric WHERE project_id = ${projectId} ORDER BY display_order ASC, key ASC
  `) as unknown as MetricRow[];
  return rows.map(toMetricDef).filter((m): m is MetricDef => m !== null);
}

/** One metric by key (any enabled state) in the current tenant's project,
 *  uncached — the admin edit view. */
export async function getMetric(key: string): Promise<MetricDef | undefined> {
  await ensureMetricsReady();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const rows = (await sql`SELECT * FROM metric WHERE key = ${key} AND project_id = ${projectId}`) as unknown as MetricRow[];
  const row = rows[0];
  if (!row) return undefined;
  return toMetricDef(row) ?? undefined;
}

// ---------------------------------------------------------------------------
// Writes — all parameterised, all validated before touching the DB.
// ---------------------------------------------------------------------------

/** Persist a brand-new metric. Assumes the key is unique — the DB's PRIMARY
 *  KEY constraint is the backstop (throws on collision), same posture as
 *  lib/store.ts's insertExperiment relying on its own PRIMARY KEY. */
export async function createMetric(input: MetricInput): Promise<string> {
  const err = validateMetricDef(input);
  if (err) throw new Error(err);
  await ensureMetricsReady();
  const key = await insertMetricRaw(input);
  invalidateMetricsCache();
  return key;
}

/** Update an existing metric in place. `key` (the parameter) is the lookup
 *  target; input.key is ignored for identity — the key is immutable, exactly
 *  like lib/store.ts's updateExperiment. */
export async function updateMetric(key: string, input: MetricInput): Promise<void> {
  const err = validateMetricDef(input);
  if (err) throw new Error(err);
  await ensureMetricsReady();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  await sql`
    UPDATE metric SET
      label = ${input.label.trim()},
      description = ${normalizeDescription(input.description)},
      kind = ${input.kind},
      direction = ${input.direction},
      unit = ${input.unit},
      numerator_field = ${input.numeratorField ?? null},
      denominator_field = ${input.denominatorField ?? null},
      value_field = ${input.valueField ?? null},
      decimals = ${input.decimals ?? 1},
      is_goal = ${input.isGoal ?? false},
      show_in_table = ${input.showInTable ?? true},
      display_order = ${input.displayOrder ?? 100},
      enabled = ${input.enabled ?? true}
    WHERE key = ${key} AND project_id = ${projectId}
  `;
  invalidateMetricsCache();
}

/** Delete a metric. Returns true when a row was removed. */
export async function deleteMetric(key: string): Promise<boolean> {
  await ensureMetricsReady();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const rows = (await sql`DELETE FROM metric WHERE key = ${key} AND project_id = ${projectId} RETURNING key`) as unknown as unknown[];
  invalidateMetricsCache();
  return rows.length > 0;
}
