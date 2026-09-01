// ============================================================================
// Wasabi — DB-backed roadmap store (server-only).
// ----------------------------------------------------------------------------
// The runtime source of truth for the test roadmap. Replaces the read-only
// static lib/roadmap.ts array with Postgres-backed rows the drag-and-drop runway
// can re-order and re-time — so a re-plan persists for everyone, not just the
// tab that dragged it.
//
// The static ROADMAP in lib/roadmap.ts stays: it is now the SEED source (applied
// once, on an empty table) and the graceful-degradation fallback when the DB is
// unreachable. Lane-level metadata (business / repo / site) is fixed per lane and
// lives in code (LANE_META) — only the per-test fields are stored.
//
// SERVER-ONLY: imports lib/db.ts (Neon Postgres). Never import from a client
// component — go through a server component or the /api/admin/roadmap route. All
// DB access is async, so every public function is a Promise. Mirrors lib/store.ts.
// ============================================================================
import { getSql, createSchema } from "./db";
import {
  LANES,
  LANE_META,
  ROADMAP,
  TOTAL_WEEKS,
  roadmapTestId,
  type Lane,
  type RoadmapLane,
  type RoadmapTest,
  type TestStatus,
} from "./roadmap";
import { getCurrentOrgId } from "./tenant";

// ---------------------------------------------------------------------------
// Row shape (snake_case, as stored)
// ---------------------------------------------------------------------------

interface RoadmapRow {
  id: string;
  lane: string;
  ticket: string;
  title: string;
  surface: string;
  start_week: number;
  end_week: number;
  status: string;
  pilot: number;
  note: string | null;
  rerun_of: string | null;
  position: number;
  org_id: string;
}

const LANE_SET = new Set<Lane>(LANES);
const STATUS_SET = new Set<TestStatus>(["live", "prod-review", "built", "pending"]);

function isLane(value: string): value is Lane {
  return LANE_SET.has(value as Lane);
}
function toStatus(value: string): TestStatus {
  return STATUS_SET.has(value as TestStatus) ? (value as TestStatus) : "built";
}

// ---------------------------------------------------------------------------
// Row → domain mapper
// ---------------------------------------------------------------------------

function toTest(row: RoadmapRow): RoadmapTest {
  const test: RoadmapTest = {
    id: row.id,
    ticket: row.ticket ?? "",
    title: row.title,
    surface: row.surface ?? "",
    startWeek: row.start_week,
    endWeek: row.end_week,
    status: toStatus(row.status),
  };
  if (row.pilot === 1) test.pilot = true;
  if (row.note != null && row.note.length > 0) test.note = row.note;
  if (row.rerun_of != null && row.rerun_of.length > 0) test.rerunOf = row.rerun_of;
  return test;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The full roadmap as RoadmapLane[], in fixed lane order (LANES), each lane's
 * tests ordered by position then start_week. Lane metadata comes from LANE_META,
 * never the DB. Every known lane is emitted even when it has no rows yet, so the
 * runway always shows all four rows.
 */
export async function listRoadmap(): Promise<RoadmapLane[]> {
  await ensureReady();
  const sql = getSql();
  const orgId = await getCurrentOrgId();
  const rows = (await sql`
    SELECT * FROM roadmap_test WHERE org_id = ${orgId} ORDER BY position ASC, start_week ASC, id ASC
  `) as unknown as RoadmapRow[];

  const byLane = new Map<Lane, RoadmapTest[]>();
  for (const lane of LANES) byLane.set(lane, []);
  for (const row of rows) {
    if (!isLane(row.lane)) continue; // unknown lane — skip rather than crash the render
    byLane.get(row.lane)!.push(toTest(row));
  }

  return LANES.map((lane) => ({
    lane,
    business: LANE_META[lane].business,
    repo: LANE_META[lane].repo,
    site: LANE_META[lane].site,
    tests: byLane.get(lane)!,
  }));
}

/**
 * Find a single roadmap test by its ticket id (e.g. "GP-452"), with the lane it
 * belongs to — the async, DB-backed twin of the static findRoadmapTest. An empty
 * ticket never matches (drafted tests aren't addressable by ticket).
 */
export async function findRoadmapTestAsync(
  ticket: string,
): Promise<{ lane: RoadmapLane; test: RoadmapTest } | undefined> {
  if (!ticket) return undefined;
  const lanes = await listRoadmap();
  for (const lane of lanes) {
    const test = lane.tests.find((t) => t.ticket === ticket);
    if (test) return { lane, test };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface RoadmapPatch {
  lane?: Lane;
  startWeek?: number;
  endWeek?: number;
  position?: number;
}

/** Thrown for a caller-fixable bad patch (bad lane, weeks out of range). */
export class RoadmapValidationError extends Error {}

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

/**
 * Move / re-time / re-order one roadmap test. Only the four drag-driven fields
 * can change; ticket, title, status etc. are immutable here. Validates the lane
 * and the week window (1..TOTAL_WEEKS, start ≤ end) and throws
 * RoadmapValidationError on a bad patch so the endpoint can answer 400 rather
 * than 500. A no-op patch (nothing to set) is a silent success.
 */
export async function updateRoadmapTest(
  id: string,
  patch: RoadmapPatch,
): Promise<void> {
  await ensureReady();

  if (patch.lane !== undefined && !isLane(patch.lane)) {
    throw new RoadmapValidationError(
      `Unknown lane "${patch.lane}". Expected one of ${LANES.join(", ")}.`,
    );
  }

  const hasStart = patch.startWeek !== undefined;
  const hasEnd = patch.endWeek !== undefined;
  if (hasStart || hasEnd) {
    // A week window must be set as a pair — validating one against a stored value
    // it can't see would let start > end slip through.
    if (!hasStart || !hasEnd) {
      throw new RoadmapValidationError(
        "startWeek and endWeek must be provided together.",
      );
    }
    if (!isInt(patch.startWeek) || !isInt(patch.endWeek)) {
      throw new RoadmapValidationError("Weeks must be whole numbers.");
    }
    if (
      patch.startWeek < 1 ||
      patch.endWeek < 1 ||
      patch.startWeek > TOTAL_WEEKS ||
      patch.endWeek > TOTAL_WEEKS
    ) {
      throw new RoadmapValidationError(
        `Weeks must fall within 1..${TOTAL_WEEKS}.`,
      );
    }
    if (patch.startWeek > patch.endWeek) {
      throw new RoadmapValidationError("startWeek must be ≤ endWeek.");
    }
  }

  if (patch.position !== undefined && (!isInt(patch.position) || patch.position < 0)) {
    throw new RoadmapValidationError("position must be a non-negative whole number.");
  }

  // Nothing to change — treat as a success (the row is already where it should be).
  if (
    patch.lane === undefined &&
    !hasStart &&
    !hasEnd &&
    patch.position === undefined
  ) {
    return;
  }

  const sql = getSql();
  const orgId = await getCurrentOrgId();
  // COALESCE keeps any field the patch omits at its stored value, so this one
  // statement handles every partial patch without branching the SQL. The explicit
  // ::text / ::int casts give the bound NULLs a concrete type (Postgres can't
  // infer the type of a bare NULL parameter). org_id in the WHERE means a
  // foreign-org id behaves exactly like an unknown id — a harmless no-op,
  // same as today's already-silent "nothing matched" case.
  await sql`
    UPDATE roadmap_test SET
      lane       = COALESCE(${patch.lane ?? null}::text, lane),
      start_week = COALESCE(${hasStart ? patch.startWeek : null}::int, start_week),
      end_week   = COALESCE(${hasEnd ? patch.endWeek : null}::int, end_week),
      position   = COALESCE(${patch.position ?? null}::int, position)
    WHERE id = ${id} AND org_id = ${orgId}
  `;
}

// ---------------------------------------------------------------------------
// Seed-once — apply the static ROADMAP to an empty table so a fresh DB renders
// the curated plan. Seeds only when empty (so a user-moved tile never reverts).
// ---------------------------------------------------------------------------

let readyPromise: Promise<void> | null = null;

function ensureReady(): Promise<void> {
  return (readyPromise ??= initOnce());
}

async function insertRow(
  lane: Lane,
  test: RoadmapTest,
  position: number,
): Promise<void> {
  const sql = getSql();
  const orgId = await getCurrentOrgId();
  const id = roadmapTestId(test);
  await sql`
    INSERT INTO roadmap_test
      (id, lane, ticket, title, surface, start_week, end_week, status, pilot, note, rerun_of, position, org_id)
    VALUES (
      ${id}, ${lane}, ${test.ticket}, ${test.title}, ${test.surface},
      ${test.startWeek}, ${test.endWeek}, ${test.status},
      ${test.pilot ? 1 : 0}, ${test.note ?? null}, ${test.rerunOf ?? null}, ${position}, ${orgId}
    )
  `;
}

async function initOnce(): Promise<void> {
  await createSchema();
  const sql = getSql();
  // Scoped to the current tenant's org, same "seed once PER TENANT" reasoning
  // as lib/store.ts's initOnce — see that function's comment.
  const orgId = await getCurrentOrgId();
  const rows = (await sql`SELECT COUNT(*)::int AS n FROM roadmap_test WHERE org_id = ${orgId}`) as unknown as {
    n: number;
  }[];
  if ((rows[0]?.n ?? 0) > 0) return;
  // Per-row isolation: a cold-start race (another instance inserting the same id)
  // fails only that row, not the rest — so the table still ends up complete
  // rather than permanently partial. Position = index within the lane.
  for (const lane of ROADMAP) {
    let position = 0;
    for (const test of lane.tests) {
      try {
        await insertRow(lane.lane, test, position);
      } catch (err) {
        console.warn(
          "[wasabi] roadmap seed skipped:",
          roadmapTestId(test),
          err instanceof Error ? err.message : err,
        );
      }
      position += 1;
    }
  }
}
