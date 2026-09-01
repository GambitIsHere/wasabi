// ============================================================================
// scripts/migrate-tenancy.ts — CLI entrypoint for the multi-tenancy migration.
// ----------------------------------------------------------------------------
// Adds the tenancy columns to the tables that pre-date the tenancy seam:
//   - experiment, archived_experiment, event, metric  → project_id
//   - roadmap_test                                    → org_id
// (variant / archived_variant are deliberately left alone — see lib/tenant.ts's
// header for the per-table reasoning) and backfills every existing row onto
// the Sanjow org / default project the same constants define.
//
// WHY THIS ISN'T IN lib/db.ts's automatic createSchema(): that path runs on
// every cold start, unreviewed, against whatever DATABASE_URL is set — fine for
// additive `CREATE TABLE IF NOT EXISTS` (organization/project/api_key ARE
// created there — see lib/db.ts), NOT fine for `ALTER TABLE` on tables that
// already hold live production rows. This script is the explicit,
// separately-invoked, human-run alternative — same reasoning as
// scripts/reseed.ts. It is idempotent (every statement below is safe to
// re-run: IF NOT EXISTS / WHERE …IS NULL / ON CONFLICT DO NOTHING / re-applying
// the same SET NOT NULL / dropping an already-absent DEFAULT), so running it
// twice is a no-op the second time.
//
// NO COLUMN DEFAULT (I9): each new column is backfilled to the Sanjow
// org/project for EXISTING rows and made NOT NULL, but its DEFAULT is then
// DROPPED. A lingering DEFAULT is a silent-wrong-tenant-write trap: any future
// INSERT that forgot project_id/org_id would land in Sanjow's data with no
// error. The tenancy seam's data modules (lib/store.ts etc.) always pass the
// column explicitly, so no default is needed; NOT NULL without a default makes
// a forgotten column fail LOUD instead of silently mis-attributing the row.
// (An earlier version of this script SET the default; dropping it here is
// idempotent — DROP DEFAULT on a column with none is a no-op — so re-running
// this script cleans up a default a previous run may already have set.)
//
// SAFETY: hard-gated to local Postgres. Refuses to run unless USE_LOCAL_PG=1
// is set — the same flag lib/db.ts and middleware.ts use to detect local dev
// (see LOCAL-DEV.md's "Safety" section: this flag is absent in every deployed
// environment, so it can't accidentally fire against Neon cloud). A production
// run is a deliberate, separate, reviewed action outside this script's scope —
// not something this script (or this batch) does.
//
// Run from `dashboard/` (with docker-compose.dev.yml up and .env.local in
// place — see LOCAL-DEV.md):
//   npm run migrate:tenancy
// ============================================================================
import { getSql, createSchema } from "../lib/db.ts";
import {
  SANJOW_ORG_ID,
  SANJOW_ORG_NAME,
  SANJOW_ORG_VERIFIED_DOMAIN,
  SANJOW_DEFAULT_PROJECT_ID,
  SANJOW_DEFAULT_PROJECT_NAME,
} from "../lib/tenant.ts";

if (process.env.USE_LOCAL_PG !== "1") {
  console.error("[migrate-tenancy] refusing to run: USE_LOCAL_PG=1 is not set in the environment.");
  console.error("[migrate-tenancy] this migration only runs against local Postgres (docker-compose.dev.yml) —");
  console.error("[migrate-tenancy] see LOCAL-DEV.md. A production run is a separate, deliberate, reviewed step.");
  process.exit(2);
}

/** One (table, tenant column, tenant id) job — the five ALTERs are identical
 *  shape, so this loop is the single place that shape is written, rather than
 *  five near-duplicate blocks that could drift out of sync with each other. */
interface TenantColumnJob {
  table: "experiment" | "archived_experiment" | "event" | "metric" | "roadmap_test";
  column: "project_id" | "org_id";
  refTable: "project" | "organization";
  tenantId: string;
}

const JOBS: TenantColumnJob[] = [
  { table: "experiment", column: "project_id", refTable: "project", tenantId: SANJOW_DEFAULT_PROJECT_ID },
  { table: "archived_experiment", column: "project_id", refTable: "project", tenantId: SANJOW_DEFAULT_PROJECT_ID },
  { table: "event", column: "project_id", refTable: "project", tenantId: SANJOW_DEFAULT_PROJECT_ID },
  { table: "metric", column: "project_id", refTable: "project", tenantId: SANJOW_DEFAULT_PROJECT_ID },
  { table: "roadmap_test", column: "org_id", refTable: "organization", tenantId: SANJOW_ORG_ID },
];

/** Table/column names here are from the fixed JOBS list above (never user
 *  input), so building the statement text directly is safe — the neon
 *  driver's tagged template can't parameterise identifiers (table/column
 *  names) anyway, only values. `sql.unsafe()` marks that deliberately, per
 *  the driver's own docs (see its `unsafe()` example). */
async function runJob(sql: ReturnType<typeof getSql>, job: TenantColumnJob): Promise<void> {
  const { table, column, refTable, tenantId } = job;
  console.log(`[migrate-tenancy] ${table}.${column} …`);

  await sql`
    ALTER TABLE ${sql.unsafe(table)}
    ADD COLUMN IF NOT EXISTS ${sql.unsafe(column)} TEXT REFERENCES ${sql.unsafe(refTable)}(id)
  `;
  // DML (not DDL) — a normal bound parameter is fine here. Backfills EXISTING
  // rows onto the tenant; new rows must always pass the column explicitly.
  await sql`
    UPDATE ${sql.unsafe(table)} SET ${sql.unsafe(column)} = ${tenantId} WHERE ${sql.unsafe(column)} IS NULL
  `;
  await sql`
    ALTER TABLE ${sql.unsafe(table)} ALTER COLUMN ${sql.unsafe(column)} SET NOT NULL
  `;
  // DROP the default (I9): keep NOT NULL, but never leave a DEFAULT that would
  // silently land a forgotten-column INSERT in Sanjow's data. Idempotent —
  // DROP DEFAULT on a column with no default is a no-op — so this is safe to
  // re-run, including after an earlier run of this script that SET the default.
  await sql`
    ALTER TABLE ${sql.unsafe(table)} ALTER COLUMN ${sql.unsafe(column)} DROP DEFAULT
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS ${sql.unsafe(`${table}_${column}_idx`)} ON ${sql.unsafe(table)} (${sql.unsafe(column)})
  `;
}

async function main(): Promise<void> {
  console.log("[migrate-tenancy] connecting to local Postgres…");
  await createSchema(); // organization / project / api_key are additive — safe here too.
  const sql = getSql();

  console.log("[migrate-tenancy] backfilling org + default project…");
  await sql`
    INSERT INTO organization (id, name, verified_domain)
    VALUES (${SANJOW_ORG_ID}, ${SANJOW_ORG_NAME}, ${SANJOW_ORG_VERIFIED_DOMAIN})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO project (id, org_id, name)
    VALUES (${SANJOW_DEFAULT_PROJECT_ID}, ${SANJOW_ORG_ID}, ${SANJOW_DEFAULT_PROJECT_NAME})
    ON CONFLICT (id) DO NOTHING
  `;

  for (const job of JOBS) {
    await runJob(sql, job);
  }

  console.log("[migrate-tenancy] done.");
}

main().catch((err) => {
  console.error("[migrate-tenancy] failed:", err);
  process.exit(1);
});
