// ============================================================================
// Wasabi — event log (server-only). The ASSIGNMENT side of the cockpit feed.
// ----------------------------------------------------------------------------
// /api/capture is public + unauthenticated and used to discard every event.
// This module is the sink it now writes to: one row per capture in the `event`
// table (schema in lib/db.ts). The PAYMENT side of the cockpit (auth / rebill /
// declined + amounts) is read live from global-api via Metabase — NOT from here.
// So this table holds only what Metabase cannot: assignment activity (who landed
// in which arm, when) plus any storefront conversion pings.
//
// Two invariants keep the public endpoint safe:
//   1. FAIL-OPEN — the route wraps persistEvent() in try/catch; a DB hiccup must
//      never fail or slow a storefront capture. This module therefore does the
//      minimum work (one INSERT, an occasional prune) and lets errors propagate
//      to that caller's catch rather than swallowing them here.
//   2. BOUNDED — the table is pruned to a 7-day retention window with a 10,000-row
//      hard cap, so an unauthenticated firehose can't grow it without limit.
//
// SERVER-ONLY: imports lib/db.ts (Neon Postgres). Never import from a client
// component. All access is async (serverless Postgres over HTTP).
// ============================================================================
import { getSql, createSchema } from "./db";
import { getCurrentProjectId } from "./tenant";

// ---------------------------------------------------------------------------
// Bounding policy — documented single source of truth.
// ---------------------------------------------------------------------------

/** Rows older than this are pruned. Assignment activity past a week has no place
 *  in a live "what's happening now" feed. */
const RETENTION_DAYS = 7;
/** Second guard: even inside the window, never keep more than this many rows
 *  PER PROJECT (see pruneEvents below) — so one tenant's insert volume can
 *  never evict another tenant's events from the cap. */
const HARD_CAP = 10_000;
/** Prune runs on ~this share of inserts, so the common capture path is a single
 *  INSERT round-trip (no added latency) while the table still stays bounded. */
const PRUNE_PROBABILITY = 0.02;

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Start of the current UTC day as an ISO-8601 string (e.g. "2026-08-31T00:00:00.000Z").
 *  `ts` is always a UTC ISO string, so a lexicographic `ts >= startOfTodayIso()`
 *  is a correct chronological "today" filter. UTC is deliberate: it makes the
 *  window deterministic and matches how Metabase timestamps are compared. */
export function startOfTodayIso(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

// ---------------------------------------------------------------------------
// Kinds & shapes
// ---------------------------------------------------------------------------

/** What a stored event represents. `assignment` = a visitor landed in an arm;
 *  `conversion` = any other storefront ping (kept, but the money truth is Metabase). */
export type EventKind = "assignment" | "conversion";

/** One row to persist, already parsed from the capture wire body. */
export interface EventToPersist {
  /** UTC ISO-8601 timestamp. Callers pass the wire timestamp or now(). */
  ts: string;
  distinctId: string;
  /** The raw event name, e.g. "$assignment" or a conversion name. */
  event: string;
  experimentKey: string | null;
  variant: string | null;
  business: string | null;
  kind: EventKind;
}

/** A stored assignment row, read back for the feed / counts. */
export interface StoredEventRow {
  ts: string;
  distinctId: string;
  event: string;
  experimentKey: string | null;
  variant: string | null;
  business: string | null;
}

interface RawEventRow {
  ts: string;
  distinct_id: string;
  event: string;
  experiment_key: string | null;
  variant: string | null;
  business: string | null;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Persist one captured event. Ensures the schema exists (idempotent + memoised,
 * NO seeding — unlike the store's ensureReady), inserts the row, then prunes on a
 * small fraction of calls to keep the table bounded.
 *
 * Does NOT catch its own errors — the public route owns the try/catch so the
 * fail-open contract lives in exactly one place. On serverless this is awaited
 * (a single Neon HTTP round-trip) so the write actually lands before the function
 * suspends; that round-trip is the only latency the endpoint adds.
 *
 * Stamped with the current tenant's project_id — today always the Sanjow
 * default (getCurrentTenant does no I/O yet), so this doesn't add latency or
 * a new failure mode to the public /api/capture path it backs.
 */
export async function persistEvent(row: EventToPersist): Promise<void> {
  await createSchema();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  await sql`
    INSERT INTO event (ts, distinct_id, event, experiment_key, variant, business, kind, project_id)
    VALUES (${row.ts}, ${row.distinctId}, ${row.event}, ${row.experimentKey},
            ${row.variant}, ${row.business}, ${row.kind}, ${projectId})
  `;
  if (Math.random() < PRUNE_PROBABILITY) await pruneEvents(sql);
}

/**
 * Enforce the retention window + hard cap. Cheap enough to run inline
 * occasionally. The two guards deliberately have DIFFERENT scopes:
 *
 *   - RETENTION WINDOW stays GLOBAL. Anything older than RETENTION_DAYS is
 *     stale for every tenant equally — a uniform expiry policy, not a
 *     fairness question, so there is nothing to scope per-project here.
 *
 *   - HARD CAP is now PER-PROJECT (M2/M3 hardening). It used to be one global
 *     `ORDER BY id DESC LIMIT HARD_CAP`, which meant a single noisy tenant's
 *     insert volume could evict ANOTHER tenant's events from the cap well
 *     before that tenant's own retention window expired — correct with one
 *     tenant, a real fairness bug the moment a second tenant has real
 *     traffic. The ROW_NUMBER() OVER (PARTITION BY project_id …) below keeps
 *     each project's own newest HARD_CAP rows independently — no schema
 *     change needed, `event.project_id` already exists (scripts/migrate-tenancy.ts).
 *
 * TENANT-SCOPE-EXEMPT (both statements): this is table-size hygiene (the
 * BOUNDED guarantee in the header comment above), not a per-request data
 * read/write scoped to "the current caller's project" — pruneEvents has no
 * single caller/project context, it is a maintenance pass across every
 * tenant's rows at once. That holds for the hard-cap statement too even
 * though its text now references project_id (via PARTITION BY, not a bound
 * `${projectId}` value) — so both stay out of the tenant-scoping guard
 * (lib/tenant-scoping.test.ts), not because project_id is missing from the
 * hard-cap query, but because "which project" was never the right question
 * for either statement.
 */
async function pruneEvents(sql: ReturnType<typeof getSql>): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  // TENANT-SCOPE-EXEMPT: see the function header above (retention window).
  await sql`DELETE FROM event WHERE ts < ${cutoff}`;
  // TENANT-SCOPE-EXEMPT: see the function header above (hard cap). Keep only
  // the newest HARD_CAP rows WITHIN EACH project_id, drop the rest — so
  // tenant A's events can never be pushed out by tenant B's volume.
  await sql`
    DELETE FROM event
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY id DESC) AS rn
        FROM event
      ) ranked
      WHERE rn > ${HARD_CAP}
    )
  `;
}

// ---------------------------------------------------------------------------
// Reads (the assignment side of home.ts). Never throw on an empty store — they
// simply return [] / 0. A missing table (schema not yet created) is guarded by
// createSchema() first.
// ---------------------------------------------------------------------------

/** Most recent assignment events, newest first. Payment events come from Metabase. */
export async function recentAssignments(limit: number): Promise<StoredEventRow[]> {
  await createSchema();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const rows = (await sql`
    SELECT ts, distinct_id, event, experiment_key, variant, business
    FROM event
    WHERE kind = 'assignment' AND project_id = ${projectId}
    ORDER BY ts DESC
    LIMIT ${limit}
  `) as unknown as RawEventRow[];
  return rows.map((r) => ({
    ts: r.ts,
    distinctId: r.distinct_id,
    event: r.event,
    experimentKey: r.experiment_key,
    variant: r.variant,
    business: r.business,
  }));
}

/** One arm's share of the assignment events still inside the retention window. */
export interface VariantAssignmentCount {
  variant: string;
  /** DISTINCT visitors, not raw events — a returning visitor re-firing
   *  assignment must not count twice or the split reads skewed. */
  visitors: number;
}

/** Per-arm assignment counts for one experiment, plus the window they cover. */
export interface AssignmentSplit {
  counts: VariantAssignmentCount[];
  /** Oldest and newest assignment ts still stored, ISO, or null when empty.
   *  The panel states these: the event table is pruned to RETENTION_DAYS with a
   *  per-project HARD_CAP, so this is a ROLLING window, never the experiment's
   *  lifetime. A split computed here is an early warning, not a final audit. */
  oldestTs: string | null;
  newestTs: string | null;
  /** Days of retention configured, so the reader can see what "the window" is
   *  without reading this file. */
  retentionDays: number;
  /** True when this project is at the row cap, meaning the window shown is
   *  shorter than retentionDays and the oldest assignments have been dropped.
   *  Uneven pruning across arms would bias the split, so a capped window is
   *  reported rather than silently used. */
  capped: boolean;
}

/**
 * Per-arm DISTINCT-visitor assignment counts for one experiment, for the SRM
 * check on the results page.
 *
 * WHY NOT VariantRow: the results payload carries payment-side figures
 * (appsAcquired, firstPaid, …), all of them downstream of assignment. Running a
 * sample-ratio test on those would not measure the split — it would measure
 * conversion differences between arms and call them a mismatch, which on a
 * genuinely winning arm fires constantly. SRM has to read assignment itself.
 *
 * WINDOW: whatever survives pruning. The caller gets oldestTs/newestTs/capped
 * so the UI can say so rather than implying a lifetime count.
 */
export async function assignmentSplitForExperiment(
  experimentKey: string,
): Promise<AssignmentSplit> {
  await createSchema();
  const sql = getSql();
  const projectId = await getCurrentProjectId();

  const rows = (await sql`
    SELECT variant, COUNT(DISTINCT distinct_id)::int AS visitors,
           MIN(ts) AS oldest, MAX(ts) AS newest
    FROM event
    WHERE kind = 'assignment'
      AND experiment_key = ${experimentKey}
      AND variant IS NOT NULL
      AND project_id = ${projectId}
    GROUP BY variant
    ORDER BY variant ASC
  `) as unknown as Array<{ variant: string; visitors: number; oldest: string | null; newest: string | null }>;

  const counts = rows.map((r) => ({ variant: r.variant, visitors: r.visitors }));
  const oldestTs = rows.reduce<string | null>(
    (a, r) => (r.oldest && (!a || r.oldest < a) ? r.oldest : a), null);
  const newestTs = rows.reduce<string | null>(
    (a, r) => (r.newest && (!a || r.newest > a) ? r.newest : a), null);

  // At or above the cap, the oldest rows for this project have been dropped and
  // the window is shorter than it looks.
  const totalForProject = (await sql`
    SELECT COUNT(*)::int AS n FROM event WHERE project_id = ${projectId}
  `) as unknown as Array<{ n: number }>;
  const capped = (totalForProject[0]?.n ?? 0) >= HARD_CAP;

  return { counts, oldestTs, newestTs, retentionDays: RETENTION_DAYS, capped };
}

/** One business's assignment count for today. */
export interface AssignmentBusinessCount {
  business: string;
  count: number;
}

/** Today's assignment counts (UTC day), total + per business. Empty store → 0 / []. */
export async function assignmentCountsToday(): Promise<{
  total: number;
  byBusiness: AssignmentBusinessCount[];
}> {
  await createSchema();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const since = startOfTodayIso();
  const rows = (await sql`
    SELECT COALESCE(business, 'Unknown') AS business, COUNT(*)::int AS count
    FROM event
    WHERE kind = 'assignment' AND ts >= ${since} AND project_id = ${projectId}
    GROUP BY COALESCE(business, 'Unknown')
    ORDER BY count DESC, business ASC
  `) as unknown as Array<{ business: string; count: number }>;
  const byBusiness = rows.map((r) => ({ business: r.business, count: r.count }));
  const total = byBusiness.reduce((sum, r) => sum + r.count, 0);
  return { total, byBusiness };
}

/**
 * Today's assignment counts (UTC day) grouped by experiment key — the per-row
 * TODAY column of the cockpit table. Same window + kind filter as
 * assignmentCountsToday; rows with a NULL experiment_key are dropped (they can't
 * be attributed to a row). Empty store → {}.
 */
export async function assignmentCountsTodayByExperiment(): Promise<
  Record<string, number>
> {
  await createSchema();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const since = startOfTodayIso();
  const rows = (await sql`
    SELECT experiment_key AS key, COUNT(*)::int AS count
    FROM event
    WHERE kind = 'assignment' AND ts >= ${since} AND experiment_key IS NOT NULL AND project_id = ${projectId}
    GROUP BY experiment_key
  `) as unknown as Array<{ key: string; count: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.key] = r.count;
  return out;
}

/** Counts for one arm (or the whole experiment): assignments vs goal captures,
 *  today (UTC) and all-time-in-window (the event table is pruned to 7 days). */
export interface WiringCounts {
  assignmentsToday: number;
  assignmentsTotal: number;
  capturesToday: number;
  capturesTotal: number;
}

/** One experiment's wiring health: whole-experiment totals plus a per-arm
 *  breakdown keyed by variant. `byArm` only holds arms that have events; the
 *  caller pairs it against the experiment's declared arms so zero-traffic arms
 *  still render. */
export interface ExperimentWiring extends WiringCounts {
  byArm: Record<string, WiringCounts>;
}

const ZERO_COUNTS: WiringCounts = {
  assignmentsToday: 0,
  assignmentsTotal: 0,
  capturesToday: 0,
  capturesTotal: 0,
};

/** An empty wiring result — the honest state for an experiment with no events
 *  yet (and the safe fallback a caller can use if the read is skipped). */
export const EMPTY_WIRING: ExperimentWiring = { ...ZERO_COUNTS, byArm: {} };

/** One grouped-events row (variant × kind) as returned by the wiring query. */
export interface WiringEventGroup {
  variant: string | null;
  kind: string;
  total: number;
  today: number;
}

/**
 * Fold grouped (variant × kind) event counts into an ExperimentWiring. PURE —
 * no I/O — so the aggregation (assignment vs capture split, per-arm breakdown,
 * NULL-variant handling) is unit-testable without a DB. `kind` is 'assignment'
 * for bucketing pings and 'conversion' for every other capture (goal fires) —
 * see the capture route's classify(). A NULL variant (a capture with no arm
 * attribution) still counts toward the experiment totals but is dropped from
 * `byArm` (it can't be attributed to a row).
 */
export function foldWiringRows(rows: readonly WiringEventGroup[]): ExperimentWiring {
  const result: ExperimentWiring = { ...ZERO_COUNTS, byArm: {} };
  for (const r of rows) {
    const total = Number(r.total) || 0;
    const today = Number(r.today) || 0;
    const isAssignment = r.kind === "assignment";
    if (isAssignment) {
      result.assignmentsTotal += total;
      result.assignmentsToday += today;
    } else {
      result.capturesTotal += total;
      result.capturesToday += today;
    }
    if (r.variant === null) continue;
    const arm = (result.byArm[r.variant] ??= { ...ZERO_COUNTS });
    if (isAssignment) {
      arm.assignmentsTotal += total;
      arm.assignmentsToday += today;
    } else {
      arm.capturesTotal += total;
      arm.capturesToday += today;
    }
  }
  return result;
}

/**
 * Wiring health for ONE experiment: is it receiving assignments, and is the goal
 * event being captured — today and total — overall and per arm. Read entirely
 * from the local `event` store (assignment side); it never touches Metabase, so
 * it works locally and returns EMPTY_WIRING (not an error) for an experiment
 * that has no events yet.
 */
export async function experimentWiring(key: string): Promise<ExperimentWiring> {
  await createSchema();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const since = startOfTodayIso();
  const rows = (await sql`
    SELECT variant, kind,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE ts >= ${since})::int AS today
    FROM event
    WHERE experiment_key = ${key} AND project_id = ${projectId}
    GROUP BY variant, kind
  `) as unknown as WiringEventGroup[];
  return foldWiringRows(rows);
}
