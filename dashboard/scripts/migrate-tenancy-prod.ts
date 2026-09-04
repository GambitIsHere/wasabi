// ============================================================================
// scripts/migrate-tenancy-prod.ts — the DELIBERATE, REVIEWED production run of
// the multi-tenancy migration that scripts/migrate-tenancy.ts (local-only)
// explicitly leaves out of scope.
// ----------------------------------------------------------------------------
// scripts/migrate-tenancy.ts is HARD-GATED to local Postgres (USE_LOCAL_PG=1,
// which also repoints lib/db.ts at the local proxy) precisely so it can never
// fire against Neon cloud. Its header says a production run is "a deliberate,
// separate, reviewed action outside this script's scope." This file IS that
// action. Same DDL, same constants, same lib/db.ts schema code (so it can't
// drift) — but split into two safe phases and run against real Neon.
//
// WHY TWO PHASES (the reason this isn't just the local script pointed at prod):
// the local script does ADD COLUMN → backfill → SET NOT NULL → DROP DEFAULT in
// one shot. On a live DB, the moment a column is NOT NULL with no default, any
// INSERT that omits it fails — so the *pre-tenant* build (still live until the
// tenant build deploys) would start erroring on every write in the gap between
// migrating and deploying. Splitting removes that window entirely:
//
//   phase1  ADD COLUMN (nullable) + backfill + seed org/project + index.
//           Fully backward-compatible: the pre-tenant build ignores the new
//           nullable columns and its inserts still succeed (NULL is allowed).
//           Safe to run ANY time before the deploy, with no rush.
//   <deploy the tenant build>   ← now every INSERT supplies org_id/project_id.
//   phase2  re-backfill any rows the pre-tenant build inserted as NULL during
//           the gap, verify zero NULLs remain, THEN SET NOT NULL + DROP DEFAULT.
//           Safe because the live build now always passes the columns.
//
// REVERSIBILITY (so this never depends on a PITR window):
//   rollback2  ALTER COLUMN DROP NOT NULL   (undoes phase2; data untouched)
//   rollback1  DROP COLUMN                  (undoes phase1; removes the added
//              column + its backfilled values; leaves the seeded org/project
//              rows, which are harmless and the tenant build needs anyway)
// No step ever mutates or deletes a pre-existing row's data — phase1 only ADDs
// columns and backfills them, phase2 only tightens constraints.
//
// SAFETY GATES (this is the prod script, so its guards are the inverse of the
// local one's):
//   - REFUSES if USE_LOCAL_PG=1 is set (that flag means "local"; this is prod).
//   - REFUSES any write mode unless CONFIRM_PROD_TENANCY_MIGRATION=1 is set.
//   - REQUIRES an explicit --mode; prints the target DB host (never the
//     credentials) so the operator confirms they're pointed at the right DB.
//   - `check` is read-only and needs neither the confirm flag nor any write.
//
// IDEMPOTENT: every mode is safe to re-run (IF NOT EXISTS / WHERE …IS NULL /
// ON CONFLICT DO NOTHING / SET NOT NULL on an already-NOT-NULL column / DROP
// DEFAULT on a column with none / DROP …IF EXISTS).
//
// RUN (from dashboard/, with the prod Neon URL in DATABASE_URL and USE_LOCAL_PG
// UNSET — same loader flags as the local script):
//   DATABASE_URL="<prod-non-pooling-url>" \
//   node --experimental-strip-types --no-warnings \
//     --import ./scripts/ts-resolve-hook-register.mjs \
//     scripts/migrate-tenancy-prod.ts --mode=check
//   # then, for the real thing, add CONFIRM_PROD_TENANCY_MIGRATION=1 and
//   # --mode=phase1 ; deploy ; --mode=phase2.
// ============================================================================
import { getSql, createSchema } from "../lib/db.ts";
import {
  SANJOW_ORG_ID,
  SANJOW_ORG_NAME,
  SANJOW_ORG_VERIFIED_DOMAIN,
  SANJOW_DEFAULT_PROJECT_ID,
  SANJOW_DEFAULT_PROJECT_NAME,
} from "../lib/tenant.ts";

// --- the five (table, tenant column) jobs — byte-for-byte the same set as
// scripts/migrate-tenancy.ts's JOBS, kept here so the prod run is a faithful
// copy. If that list ever changes, this one must change with it (the review
// step for this script is: diff this JOBS against that one).
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

type Sql = ReturnType<typeof getSql>;
type Mode = "check" | "phase1" | "phase2" | "rollback2" | "rollback1";
const WRITE_MODES: Mode[] = ["phase1", "phase2", "rollback2", "rollback1"];

function parseMode(argv: string[]): Mode | null {
  const arg = argv.find((a) => a.startsWith("--mode="));
  const value = arg?.slice("--mode=".length);
  const all: Mode[] = ["check", "phase1", "phase2", "rollback2", "rollback1"];
  return all.find((m) => m === value) ?? null;
}

/** Host only — NEVER the user/password — so the operator can confirm the DB
 *  without the log leaking a credential. */
function safeHost(): string {
  const raw = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "";
  try {
    return new URL(raw).host || "(unparseable)";
  } catch {
    return "(unparseable)";
  }
}

// All three helpers pin table_schema = 'public'. This DB also has a `neon_auth`
// schema (Neon Auth) with colliding table names (organization, user, …) that
// the wasabi app never touches — without the pin, information_schema would
// match those and report the wrong answer. 'public' is where the app's
// unqualified DDL/queries resolve (its search_path is "$user", public, and the
// $user schema doesn't exist), so pinning it mirrors the app exactly.
async function tableExists(sql: Sql, table: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${table}
  `) as unknown as unknown[];
  return rows.length > 0;
}

async function columnExists(sql: Sql, table: string, column: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `) as unknown as unknown[];
  return rows.length > 0;
}

async function count(sql: Sql, table: string, whereNullColumn?: string): Promise<number> {
  const rows = whereNullColumn
    ? ((await sql`SELECT count(*)::int AS n FROM ${sql.unsafe(table)} WHERE ${sql.unsafe(whereNullColumn)} IS NULL`) as unknown as { n: number }[])
    : ((await sql`SELECT count(*)::int AS n FROM ${sql.unsafe(table)}`) as unknown as { n: number }[]);
  return rows[0]?.n ?? 0;
}

async function isNotNull(sql: Sql, table: string, column: string): Promise<boolean> {
  const rows = (await sql`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `) as unknown as { is_nullable: string }[];
  return rows[0]?.is_nullable === "NO";
}

async function runCheck(sql: Sql): Promise<void> {
  console.log("[prod-tenancy] read-only check\n");
  if (await tableExists(sql, "organization")) {
    const org = (await sql`SELECT id FROM organization WHERE id = ${SANJOW_ORG_ID}`) as unknown as unknown[];
    const proj = (await sql`SELECT id FROM project WHERE id = ${SANJOW_DEFAULT_PROJECT_ID}`) as unknown as unknown[];
    console.log(`  organization '${SANJOW_ORG_ID}': ${org.length ? "present" : "MISSING"}`);
    console.log(`  project '${SANJOW_DEFAULT_PROJECT_ID}': ${proj.length ? "present" : "MISSING"}\n`);
  } else {
    console.log("  organization/project tables: ABSENT (createSchema hasn't run on this DB yet — phase1 creates them)\n");
  }
  for (const { table, column } of JOBS) {
    if (!(await tableExists(sql, table))) {
      console.log(`  ${table}.${column}: base table ABSENT`);
      continue;
    }
    if (!(await columnExists(sql, table, column))) {
      const total = await count(sql, table);
      console.log(`  ${table}.${column}: column ABSENT · rows=${total}`);
      continue;
    }
    const total = await count(sql, table);
    const nulls = await count(sql, table, column);
    const notNull = await isNotNull(sql, table, column);
    console.log(
      `  ${table}.${column}: present · rows=${total} · nulls=${nulls} · NOT NULL=${notNull ? "yes" : "no"}`,
    );
  }
}

async function seedOrgAndProject(sql: Sql): Promise<void> {
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
}

async function runPhase1(sql: Sql): Promise<void> {
  console.log("[prod-tenancy] phase 1 — add nullable columns, backfill, seed, index\n");
  await createSchema(); // organization/project/api_key/user/membership — additive, safe.
  await seedOrgAndProject(sql);
  for (const { table, column, refTable, tenantId } of JOBS) {
    console.log(`  ${table}.${column} …`);
    await sql`
      ALTER TABLE ${sql.unsafe(table)}
      ADD COLUMN IF NOT EXISTS ${sql.unsafe(column)} TEXT REFERENCES ${sql.unsafe(refTable)}(id)
    `;
    await sql`
      UPDATE ${sql.unsafe(table)} SET ${sql.unsafe(column)} = ${tenantId} WHERE ${sql.unsafe(column)} IS NULL
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS ${sql.unsafe(`${table}_${column}_idx`)} ON ${sql.unsafe(table)} (${sql.unsafe(column)})
    `;
  }
  console.log("");
  await runCheck(sql);
  console.log("\n[prod-tenancy] phase 1 done. Deploy the tenant build, then run --mode=phase2.");
}

async function runPhase2(sql: Sql): Promise<void> {
  console.log("[prod-tenancy] phase 2 — re-backfill gap rows, verify, SET NOT NULL, DROP DEFAULT\n");
  for (const { table, column, tenantId } of JOBS) {
    console.log(`  ${table}.${column} …`);
    if (!(await columnExists(sql, table, column))) {
      throw new Error(`${table}.${column} does not exist — run --mode=phase1 before phase2`);
    }
    // Catch any rows the pre-tenant build inserted as NULL between phase1 and
    // the deploy, so SET NOT NULL can't fail on a straggler.
    await sql`
      UPDATE ${sql.unsafe(table)} SET ${sql.unsafe(column)} = ${tenantId} WHERE ${sql.unsafe(column)} IS NULL
    `;
    const remaining = await count(sql, table, column);
    if (remaining > 0) {
      throw new Error(
        `refusing to SET NOT NULL on ${table}.${column}: ${remaining} NULL row(s) remain after backfill`,
      );
    }
    await sql`ALTER TABLE ${sql.unsafe(table)} ALTER COLUMN ${sql.unsafe(column)} SET NOT NULL`;
    await sql`ALTER TABLE ${sql.unsafe(table)} ALTER COLUMN ${sql.unsafe(column)} DROP DEFAULT`;
  }
  console.log("");
  await runCheck(sql);
  console.log("\n[prod-tenancy] phase 2 done. Migration complete.");
}

async function runRollback2(sql: Sql): Promise<void> {
  console.log("[prod-tenancy] rollback2 — DROP NOT NULL (undo phase 2; data untouched)\n");
  for (const { table, column } of JOBS) {
    console.log(`  ${table}.${column} …`);
    await sql`ALTER TABLE ${sql.unsafe(table)} ALTER COLUMN ${sql.unsafe(column)} DROP NOT NULL`;
  }
  console.log("\n[prod-tenancy] rollback2 done.");
}

async function runRollback1(sql: Sql): Promise<void> {
  console.log("[prod-tenancy] rollback1 — DROP COLUMN (undo phase 1)\n");
  console.log("  (leaves the seeded organization/project rows — harmless, and the tenant build needs them)\n");
  for (const { table, column } of JOBS) {
    console.log(`  ${table}.${column} …`);
    await sql`ALTER TABLE ${sql.unsafe(table)} DROP COLUMN IF EXISTS ${sql.unsafe(column)}`;
  }
  console.log("\n[prod-tenancy] rollback1 done.");
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  if (!mode) {
    console.error("[prod-tenancy] usage: --mode=check|phase1|phase2|rollback2|rollback1");
    process.exit(2);
  }
  if (process.env.USE_LOCAL_PG === "1") {
    console.error("[prod-tenancy] refusing: USE_LOCAL_PG=1 is set. This is the PRODUCTION migration —");
    console.error("[prod-tenancy] it must run against Neon cloud, not the local proxy. Unset USE_LOCAL_PG.");
    process.exit(2);
  }
  if (WRITE_MODES.includes(mode) && process.env.CONFIRM_PROD_TENANCY_MIGRATION !== "1") {
    console.error(`[prod-tenancy] refusing --mode=${mode}: set CONFIRM_PROD_TENANCY_MIGRATION=1 to run a write.`);
    console.error("[prod-tenancy] (run --mode=check first — it needs no confirmation.)");
    process.exit(2);
  }

  console.log(`[prod-tenancy] target DB host: ${safeHost()}  ·  mode: ${mode}\n`);
  const sql = getSql();

  switch (mode) {
    case "check":
      await runCheck(sql);
      break;
    case "phase1":
      await runPhase1(sql);
      break;
    case "phase2":
      await runPhase2(sql);
      break;
    case "rollback2":
      await runRollback2(sql);
      break;
    case "rollback1":
      await runRollback1(sql);
      break;
  }
}

main().catch((err) => {
  console.error("[prod-tenancy] failed:", err);
  process.exit(1);
});
