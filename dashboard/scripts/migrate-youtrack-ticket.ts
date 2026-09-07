// ============================================================================
// scripts/migrate-youtrack-ticket.ts — CLI entrypoint for the youtrack_ticket
// column migration.
// ----------------------------------------------------------------------------
// Adds a nullable `youtrack_ticket` column to the `experiment` table so a
// managed experiment can carry the YouTrack ticket it tracks (a bare ID like
// GP-603, or a full pasted URL — see lib/mgmt.ts). Read/written through
// lib/store.ts's insert/update path and rendered on the experiment detail page.
//
// WHY THIS ISN'T IN lib/db.ts's automatic createSchema(): that path runs on
// every cold start, unreviewed, against whatever DATABASE_URL is set — fine for
// additive `CREATE TABLE IF NOT EXISTS`, and the repo already runs added-column
// ALTERs (project_id) from a separately-invoked, human-run migration instead
// (scripts/migrate-tenancy.ts). This follows that precedent so the two added
// columns are managed the same way.
//
// SAFE ON A POPULATED TABLE: the column is nullable with no DEFAULT, so the
// ALTER is a metadata-only change on Postgres (no table rewrite, no backfill) —
// every existing row simply reads NULL, which lib/store.ts maps to "". The
// single statement is idempotent (ADD COLUMN IF NOT EXISTS), so running it
// twice is a no-op the second time.
//
// SAFETY: hard-gated to local Postgres. Refuses to run unless USE_LOCAL_PG=1 is
// set — the same flag lib/db.ts and middleware.ts use to detect local dev (see
// LOCAL-DEV.md's "Safety" section: this flag is absent in every deployed
// environment, so it can't accidentally fire against Neon cloud). A production
// run is a deliberate, separate, reviewed action outside this script's scope.
//
// Run from `dashboard/` (with docker-compose.dev.yml up and .env.local in
// place — see LOCAL-DEV.md):
//   npm run migrate:youtrack-ticket
// ============================================================================
import { getSql, createSchema } from "../lib/db.ts";

if (process.env.USE_LOCAL_PG !== "1") {
  console.error("[migrate-youtrack-ticket] refusing to run: USE_LOCAL_PG=1 is not set in the environment.");
  console.error("[migrate-youtrack-ticket] this migration only runs against local Postgres (docker-compose.dev.yml) —");
  console.error("[migrate-youtrack-ticket] see LOCAL-DEV.md. A production run is a separate, deliberate, reviewed step.");
  process.exit(2);
}

async function main(): Promise<void> {
  console.log("[migrate-youtrack-ticket] connecting to local Postgres…");
  await createSchema();
  const sql = getSql();

  console.log("[migrate-youtrack-ticket] experiment.youtrack_ticket …");
  await sql`ALTER TABLE experiment ADD COLUMN IF NOT EXISTS youtrack_ticket TEXT NULL`;

  console.log("[migrate-youtrack-ticket] done.");
}

main().catch((err) => {
  console.error("[migrate-youtrack-ticket] failed:", err);
  process.exit(1);
});
