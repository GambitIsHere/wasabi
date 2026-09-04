// ============================================================================
// scripts/create-gp452.ts — one-off: register VWO campaign GP-452 as a LIVE
// (active) experiment in Wasabi, scoped to the Sanjow org / default project, so
// it shows on the Experiments dashboard (app/page.tsx → listExperiments())
// instead of relying on the demo SEED.
// ----------------------------------------------------------------------------
// WHY NOT the app's own create path (lib/store.insertExperiment): that resolves
// the target project through getCurrentProjectId() → getCurrentTenant() →
// resolveTenantOrgId(), which does a dynamic `import("@/auth")` (next-auth,
// transitively next/server). That only resolves under Next's bundler with a
// live request/session — NOT under the plain `node --experimental-strip-types`
// loader this script runs under (the ts-resolve hook maps relative `.ts`
// imports only, never the `@/` alias — see scripts/ts-resolve-hook.mjs and
// lib/tenant.ts's "DYNAMIC IMPORTS, DELIBERATELY" note). So this script scopes
// EXPLICITLY to the SANJOW_DEFAULT_PROJECT_ID constant — exactly how
// scripts/migrate-tenancy.ts writes its org/project/backfill rows — while still
// reusing the app's own invariants: lib/mgmt.validateInput() (splits sum to
// 100, exactly one control, valid key/slugs, ≥2 variants) against the app's own
// goal-metric registry (lib/seeds.SEED_METRICS), and the exact INSERT shape used
// by lib/store.insertRaw() / lib/admin-reseed.applySeed().
//
// IDEMPOTENT: check-if-exists (scoped to key + project) before writing, so a
// re-run is a clean no-op. createSchema() is idempotent; the org/project rows
// are ON CONFLICT DO NOTHING; the experiment + variants are inserted in one
// non-interactive transaction only when the key is absent.
//
// SAFETY (prod-targeted — the mirror image of scripts/migrate-tenancy.ts, which
// is LOCAL-only): refuses to run against the local Postgres proxy
// (USE_LOCAL_PG=1), requires DATABASE_URL (or POSTGRES_URL), and requires an
// explicit CONFIRM_CREATE_GP452=1 before any write. It prints only the target
// DB host, never the connection string / credentials. lib/db.ts's getSql()
// speaks Neon over HTTP whenever USE_LOCAL_PG is unset, so this targets Neon.
//
// Run from `dashboard/` (Agent 1 owns the prod run):
//   DATABASE_URL='postgres://…' CONFIRM_CREATE_GP452=1 \
//     node --experimental-strip-types --no-warnings \
//       --import ./scripts/ts-resolve-hook-register.mjs scripts/create-gp452.ts
//   (or: DATABASE_URL='…' CONFIRM_CREATE_GP452=1 npm run create:gp452)
// ============================================================================
import { getSql, createSchema } from "../lib/db.ts";
import { validateInput, type ExperimentInput } from "../lib/mgmt.ts";
import { SEED_METRICS } from "../lib/seeds.ts";
import {
  SANJOW_ORG_ID,
  SANJOW_ORG_NAME,
  SANJOW_ORG_VERIFIED_DOMAIN,
  SANJOW_DEFAULT_PROJECT_ID,
  SANJOW_DEFAULT_PROJECT_NAME,
} from "../lib/tenant.ts";

// ---------------------------------------------------------------------------
// The experiment to create — GP-452 (VWO campaign id 364).
// ---------------------------------------------------------------------------
// A/B landing test on the AS UK "Exec Pass" hero: control = the dark hero,
// variant = the inverse light hero. 50/50. Primary metric is a thank-you
// conversion; `apps_acquired` is Wasabi's registry conversion-count metric
// (lib/seeds.SEED_METRICS — labelled "the conversion count").
//
// THEME SLUGS ARE PLACEHOLDERS (as_exec_pass_hero / _light): a themeSlug is
// mandatory (variant.theme_slug is NOT NULL and validateInput enforces
// THEME_SLUG_RE), but the real global-api Theme.slug values for the dark/light
// hero are not confirmed here. Payment P&L attaches to a variant BY theme slug
// (lib/metabase.ts), so until these are swapped for the real slugs the £ / auth
// / rebill verdict columns for GP-452 read the empty state — which the dashboard
// renders cleanly. Swapping the slugs (or an /admin/attach-payment pass) is the
// documented follow-up; the must-have — GP-452 visible as a LIVE test — is met.
const GP452: ExperimentInput = {
  name: "GP-452 — Exec Pass hero inverse (AS UK)",
  key: "gp-452-exec-pass-hero",
  business: "Airport Security",
  goalMetric: "apps_acquired",
  startDate: "2026-08-20",
  description:
    "AS UK Exec Pass landing test (VWO campaign 364). Control is the dark hero; the variant is the inverse light hero. Primary metric is the thank-you conversion — the live VWO read has the light variant +7.4% at ~75% probability.",
  variants: [
    { key: "control", rolloutPercentage: 50, themeSlug: "as_exec_pass_hero", isControl: true },
    { key: "variant", rolloutPercentage: 50, themeSlug: "as_exec_pass_hero_light", isControl: false },
  ],
};

// ---------------------------------------------------------------------------
// Safety guards — run before any DB connection (getSql() is lazy).
// ---------------------------------------------------------------------------
if (process.env.USE_LOCAL_PG === "1") {
  console.error("[create-gp452] refusing to run: USE_LOCAL_PG=1 is set.");
  console.error("[create-gp452] this script targets the deployed Neon DB, not the local Postgres proxy.");
  console.error("[create-gp452] unset USE_LOCAL_PG and set DATABASE_URL to the prod connection string.");
  process.exit(2);
}

const dbUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!dbUrl || dbUrl.trim().length === 0) {
  console.error("[create-gp452] DATABASE_URL (or POSTGRES_URL) must be set to the target Neon connection string.");
  console.error("[create-gp452] `vercel env pull` does NOT export the Vercel-Neon integration vars — copy the");
  console.error("[create-gp452] connection string from the Neon Console.");
  process.exit(2);
}

if (process.env.CONFIRM_CREATE_GP452 !== "1") {
  console.error("[create-gp452] refusing to run: set CONFIRM_CREATE_GP452=1 to confirm a write to the target DB.");
  console.error("[create-gp452] (re-running after GP-452 already exists is a safe no-op, but the confirm is still required.)");
  process.exit(2);
}

/** Host only — never print the connection string (it carries credentials). */
function dbHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return "(unparseable connection string — host hidden)";
  }
}
console.log(`[create-gp452] target DB host: ${dbHost(dbUrl)}`);

// ---------------------------------------------------------------------------
// Validate the definition against the app's own invariants before connecting.
// ---------------------------------------------------------------------------
const allowedGoalMetrics = SEED_METRICS.filter((m) => m.isGoal).map((m) => m.key);
const validationError = validateInput(GP452, allowedGoalMetrics);
if (validationError) {
  console.error(`[create-gp452] definition failed validation: ${validationError}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const key = GP452.key!;
  const projectId = SANJOW_DEFAULT_PROJECT_ID;

  console.log("[create-gp452] connecting to Neon…");
  await createSchema(); // idempotent — organization / project / experiment / variant tables.
  const sql = getSql();

  // Ensure the org + default project rows exist (the FK target for
  // experiment.project_id). Idempotent — same statements scripts/migrate-tenancy.ts
  // uses. On a prod DB where the tenancy migration already ran these are no-ops.
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

  // Idempotency guard — scoped to key + project, exactly like store.experimentExists().
  const existing = (await sql`
    SELECT 1 AS one FROM experiment WHERE key = ${key} AND project_id = ${projectId}
  `) as unknown as unknown[];
  if (existing.length > 0) {
    console.log(`[create-gp452] experiment "${key}" already exists in project "${projectId}" — no-op.`);
    return;
  }

  // Insert experiment + variants atomically (non-interactive transaction) — the
  // exact shape lib/store.insertRaw() uses, active = 1 (LIVE).
  const createdAt = new Date().toISOString();
  const description = (GP452.description ?? "").trim();
  await sql.transaction([
    sql`
      INSERT INTO experiment (key, name, business, active, goal_metric, start_date, created_at, description, project_id)
      VALUES (${key}, ${GP452.name.trim()}, ${GP452.business}, 1, ${GP452.goalMetric}, ${GP452.startDate}, ${createdAt}, ${description}, ${projectId})
    `,
    ...GP452.variants.map(
      (v, i) => sql`
        INSERT INTO variant (experiment_key, key, rollout_percentage, theme_slug, is_control, position)
        VALUES (${key}, ${v.key}, ${v.rolloutPercentage}, ${v.themeSlug}, ${v.isControl ? 1 : 0}, ${i})
      `,
    ),
  ]);

  // Read back for confirmation.
  const check = (await sql`
    SELECT key, active, business FROM experiment WHERE key = ${key} AND project_id = ${projectId}
  `) as unknown as { key: string; active: number; business: string }[];
  const row = check[0];
  console.log(
    `[create-gp452] created "${row?.key}" (${row?.business}, active=${row?.active}) ` +
      `in project "${projectId}" with ${GP452.variants.length} variants.`,
  );
  console.log("[create-gp452] done. It will appear on the Experiments dashboard as a live test.");
}

main().catch((err) => {
  console.error("[create-gp452] failed:", err);
  process.exit(1);
});
