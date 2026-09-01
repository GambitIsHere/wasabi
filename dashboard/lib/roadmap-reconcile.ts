// ============================================================================
// Wasabi — roadmap metadata reconcile (server-only).
// ----------------------------------------------------------------------------
// The DB-backed roadmap store seeds from the static ROADMAP once, on an empty
// table, then never re-reads the static plan — so a metadata edit in code (e.g.
// moving the Wasabi-pilot badge from GP-549 to GP-603 + GP-600) would never
// reach an already-seeded table. This reconcile closes that gap: it syncs each
// static test's IMMUTABLE metadata (ticket / title / surface / status / pilot /
// note / rerunOf) onto its DB row, matched by id, leaving the drag-owned LAYOUT
// (lane / start_week / end_week / position) untouched. A static test missing
// from the table is inserted; rows are never deleted here.
//
// Called once per request from the roadmap page (memoised, so it runs once per
// process). Best-effort: any failure is swallowed so the page still renders
// (it falls back to the static ROADMAP when the DB is unreachable anyway).
//
// SERVER-ONLY: imports lib/db.ts. Never import from a client component.
// ============================================================================
import { getSql, createSchema } from "./db";
import { ROADMAP, roadmapTestId } from "./roadmap";
import { getCurrentOrgId } from "./tenant";

let done: Promise<void> | null = null;

/** Reconcile static → DB metadata once per process. Never rejects. */
export function reconcileRoadmapMetadata(): Promise<void> {
  if (!done) {
    done = run().catch((err) => {
      console.warn(
        "[wasabi] roadmap reconcile failed:",
        err instanceof Error ? err.message : err,
      );
      done = null; // let a later request retry after a transient DB blip
    });
  }
  return done;
}

async function run(): Promise<void> {
  await createSchema();
  const sql = getSql();
  const orgId = await getCurrentOrgId();
  const existing = new Set(
    ((await sql`SELECT id FROM roadmap_test WHERE org_id = ${orgId}`) as unknown as { id: string }[]).map(
      (r) => r.id,
    ),
  );

  for (const lane of ROADMAP) {
    let position = 0;
    for (const test of lane.tests) {
      const id = roadmapTestId(test);
      try {
        if (existing.has(id)) {
          // Sync metadata only — never touch lane/week/position (drag-owned).
          await sql`
            UPDATE roadmap_test SET
              ticket   = ${test.ticket},
              title    = ${test.title},
              surface  = ${test.surface},
              status   = ${test.status},
              pilot    = ${test.pilot ? 1 : 0},
              note     = ${test.note ?? null},
              rerun_of = ${test.rerunOf ?? null}
            WHERE id = ${id} AND org_id = ${orgId}
          `;
        } else {
          // A test newly added to the static plan — insert with its static layout.
          await sql`
            INSERT INTO roadmap_test
              (id, lane, ticket, title, surface, start_week, end_week, status, pilot, note, rerun_of, position, org_id)
            VALUES (
              ${id}, ${lane.lane}, ${test.ticket}, ${test.title}, ${test.surface},
              ${test.startWeek}, ${test.endWeek}, ${test.status},
              ${test.pilot ? 1 : 0}, ${test.note ?? null}, ${test.rerunOf ?? null}, ${position}, ${orgId}
            )
          `;
        }
      } catch (err) {
        console.warn(
          "[wasabi] roadmap reconcile skipped:",
          id,
          err instanceof Error ? err.message : err,
        );
      }
      position += 1;
    }
  }
}
