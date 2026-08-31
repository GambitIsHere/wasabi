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

// ---------------------------------------------------------------------------
// Bounding policy — documented single source of truth.
// ---------------------------------------------------------------------------

/** Rows older than this are pruned. Assignment activity past a week has no place
 *  in a live "what's happening now" feed. */
const RETENTION_DAYS = 7;
/** Second guard: even inside the window, never keep more than this many rows. */
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
 */
export async function persistEvent(row: EventToPersist): Promise<void> {
  await createSchema();
  const sql = getSql();
  await sql`
    INSERT INTO event (ts, distinct_id, event, experiment_key, variant, business, kind)
    VALUES (${row.ts}, ${row.distinctId}, ${row.event}, ${row.experimentKey},
            ${row.variant}, ${row.business}, ${row.kind})
  `;
  if (Math.random() < PRUNE_PROBABILITY) await pruneEvents(sql);
}

/** Enforce the retention window + hard cap. Cheap enough to run inline occasionally. */
async function pruneEvents(sql: ReturnType<typeof getSql>): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  await sql`DELETE FROM event WHERE ts < ${cutoff}`;
  // Hard cap: keep only the newest HARD_CAP ids, drop the rest.
  await sql`
    DELETE FROM event
    WHERE id NOT IN (
      SELECT id FROM event ORDER BY id DESC LIMIT ${HARD_CAP}
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
  const rows = (await sql`
    SELECT ts, distinct_id, event, experiment_key, variant, business
    FROM event
    WHERE kind = 'assignment'
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
  const since = startOfTodayIso();
  const rows = (await sql`
    SELECT COALESCE(business, 'Unknown') AS business, COUNT(*)::int AS count
    FROM event
    WHERE kind = 'assignment' AND ts >= ${since}
    GROUP BY COALESCE(business, 'Unknown')
    ORDER BY count DESC, business ASC
  `) as unknown as Array<{ business: string; count: number }>;
  const byBusiness = rows.map((r) => ({ business: r.business, count: r.count }));
  const total = byBusiness.reduce((sum, r) => sum + r.count, 0);
  return { total, byBusiness };
}
