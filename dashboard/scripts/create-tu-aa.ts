// ============================================================================
// scripts/create-tu-aa.ts — one-off: register the "tu-aa-pipeline" A/A test as a
// LIVE (active) experiment in Wasabi, scoped to the Sanjow org / default project,
// so /api/decide assigns every Top Up visitor to an arm and the assignment→capture
// pipeline can be validated end-to-end in the tool's experiment wiring panel.
// Modelled EXACTLY on scripts/create-gp452.ts — same guards, same validation, same
// INSERT shape, same org/project scoping.
// ----------------------------------------------------------------------------
// WHY AN A/A: this experiment exists to prove the plumbing, not to move a metric.
// Both arms are identical, so no visitor sees any change; what we are checking is
// that (1) /api/decide assigns a stable arm per visitor and (2) the storefront's
// assignment lands in the `event` table so experimentWiring("tu-aa-pipeline")
// shows a non-zero, roughly 50/50 per-arm count. Once that reads clean, the same
// wiring is trusted for a real A/B.
//
// THE A/A THEME-SLUG DECISION (documented here because it drives arm setup):
//   The tool tells the two arms apart by the assigned VARIANT KEY, not by theme.
//   experimentWiring() (lib/events.ts) groups the `event` table by (variant, kind)
//   and builds byArm[variant] — so "a" vs "b" is the axis the wiring panel counts
//   on, regardless of theme slug. /api/decide is storage-free (it only computes +
//   returns featureFlags/themes — lib/engine/handlers.handleDecide); the row that
//   makes an arm visible is written by /api/capture, which reads `variant` off the
//   captured event (route.ts VARIANT_KEYS). So per-arm visibility needs only that
//   the storefront capture carries the variant key — the theme slug is irrelevant
//   to it.
//   Therefore BOTH arms share the SAME theme slug, "tu_lov_uk" — the storefront's
//   current/default recharge product (lib/resolve-product-from-theme.ts:
//   tu_lov_uk → £49, GBP, tu_subscription_1m_49, the same product a themeless
//   visitor already gets). Giving the two arms DIFFERENT slugs is what a real A/B
//   does (tu_lov_uk vs tu_lov_uk_19 changes the price the user sees) — the exact
//   opposite of an A/A. A shared current-default slug keeps both arms rendering
//   identically while the variant key still separates them in the tool. There is
//   no unique constraint on variant.theme_slug (PRIMARY KEY is
//   (experiment_key, key) — see lib/db.ts), so two arms on one slug is legal.
//   The storefront middleware (prepaid-mobile-recharge-ai) deliberately does NOT
//   apply this slug via a ?theme= redirect — forcing ?theme=tu_lov_uk would pin
//   en+GBP on non-UK visitors (proxy.ts THEME_TO_LOCALE + hasThemeCurrency) and
//   break A/A sameness — it only records the variant key. The slug here is the
//   experiment's declared arm mapping; the A/A never asks the storefront to render
//   it.
//
// WHY NOT the app's own create path (lib/store.insertExperiment): that resolves
// the target project through getCurrentProjectId() → getCurrentTenant() →
// resolveTenantOrgId(), which does a dynamic `import("@/auth")` (next-auth,
// transitively next/server). That only resolves under Next's bundler with a live
// request/session — NOT under the plain `node --experimental-strip-types` loader
// this script runs under (the ts-resolve hook maps relative `.ts` imports only,
// never the `@/` alias — see scripts/ts-resolve-hook.mjs and lib/tenant.ts's
// "DYNAMIC IMPORTS, DELIBERATELY" note). So this script scopes EXPLICITLY to the
// SANJOW_DEFAULT_PROJECT_ID constant — exactly how scripts/migrate-tenancy.ts and
// scripts/create-gp452.ts write their org/project/experiment rows — while still
// reusing the app's own invariants: lib/mgmt.validateInput() (splits sum to 100,
// exactly one control, valid key/slugs, ≥2 variants) against the app's own goal-
// metric registry (lib/seeds.SEED_METRICS), and the exact INSERT shape used by
// lib/store.insertRaw() / lib/admin-reseed.applySeed().
//
// IDEMPOTENT: check-if-exists (scoped to key + project) before writing, so a
// re-run is a clean no-op. createSchema() is idempotent; the org/project rows are
// ON CONFLICT DO NOTHING; the experiment + variants are inserted in one
// non-interactive transaction only when the key is absent.
//
// SAFETY (prod-targeted — the mirror image of scripts/migrate-tenancy.ts, which is
// LOCAL-only): refuses to run against the local Postgres proxy (USE_LOCAL_PG=1),
// requires DATABASE_URL (or POSTGRES_URL), and requires an explicit
// CONFIRM_CREATE_TU_AA=1 before any write. It prints only the target DB host,
// never the connection string / credentials. lib/db.ts's getSql() speaks Neon over
// HTTP whenever USE_LOCAL_PG is unset, so this targets Neon.
//
// Run from `dashboard/` (Agent 1 owns the prod run):
//   DATABASE_URL='postgres://…' CONFIRM_CREATE_TU_AA=1 \
//     node --experimental-strip-types --no-warnings \
//       --import ./scripts/ts-resolve-hook-register.mjs scripts/create-tu-aa.ts
//   (or: DATABASE_URL='…' CONFIRM_CREATE_TU_AA=1 npm run create:tu-aa)
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
// The experiment to create — tu-aa-pipeline (Top Up A/A pipeline validation).
// ---------------------------------------------------------------------------
// A/A on the Top Up storefront: two identical arms, 50/50, both on the current
// default recharge slug so no visitor sees a change. ACTIVE so /api/decide
// assigns from the first visitor — an inactive flag returns false for everyone
// and nothing lands in the wiring panel.
//
// goalMetric = "apps_acquired": the registry's conversion-count metric
// (lib/seeds.SEED_METRICS — "the conversion count … stands in for GOAL_METRICS'
// 'conversion' choice"). For Top Up an acquired application IS a completed
// recharge purchase, so this is the recharge/purchase conversion metric. No
// TU-specific metric exists in the registry; this is the closest valid goal.
// (Payment-side attribution for a REAL A/B joins Theme→Application→Transaction
// by DISTINCT theme slug — this A/A shares one slug on purpose, so its £/auth/
// rebill result columns read the empty state, which the dashboard renders
// cleanly. That is expected for an A/A: it validates the ASSIGNMENT side only.)
const TU_AA: ExperimentInput = {
  name: "TU A/A — pipeline validation",
  key: "tu-aa-pipeline",
  business: "Top Up",
  goalMetric: "apps_acquired",
  startDate: "2026-09-07",
  description:
    "A/A test on the Top Up storefront — two identical arms, both on the current default recharge slug, so no visitor sees a change. It validates the assignment→capture pipeline end-to-end: /api/decide assigns a stable arm per visitor and the storefront capture lands in the wiring panel ~50/50. Not a metric test.",
  variants: [
    { key: "a", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
    { key: "b", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: false },
  ],
};

// ---------------------------------------------------------------------------
// Safety guards — run before any DB connection (getSql() is lazy).
// ---------------------------------------------------------------------------
if (process.env.USE_LOCAL_PG === "1") {
  console.error("[create-tu-aa] refusing to run: USE_LOCAL_PG=1 is set.");
  console.error("[create-tu-aa] this script targets the deployed Neon DB, not the local Postgres proxy.");
  console.error("[create-tu-aa] unset USE_LOCAL_PG and set DATABASE_URL to the prod connection string.");
  process.exit(2);
}

const dbUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!dbUrl || dbUrl.trim().length === 0) {
  console.error("[create-tu-aa] DATABASE_URL (or POSTGRES_URL) must be set to the target Neon connection string.");
  console.error("[create-tu-aa] `vercel env pull` does NOT export the Vercel-Neon integration vars — copy the");
  console.error("[create-tu-aa] connection string from the Neon Console.");
  process.exit(2);
}

if (process.env.CONFIRM_CREATE_TU_AA !== "1") {
  console.error("[create-tu-aa] refusing to run: set CONFIRM_CREATE_TU_AA=1 to confirm a write to the target DB.");
  console.error("[create-tu-aa] (re-running after tu-aa-pipeline already exists is a safe no-op, but the confirm is still required.)");
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
console.log(`[create-tu-aa] target DB host: ${dbHost(dbUrl)}`);

// ---------------------------------------------------------------------------
// Validate the definition against the app's own invariants before connecting.
// ---------------------------------------------------------------------------
const allowedGoalMetrics = SEED_METRICS.filter((m) => m.isGoal).map((m) => m.key);
const validationError = validateInput(TU_AA, allowedGoalMetrics);
if (validationError) {
  console.error(`[create-tu-aa] definition failed validation: ${validationError}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const key = TU_AA.key!;
  const projectId = SANJOW_DEFAULT_PROJECT_ID;

  console.log("[create-tu-aa] connecting to Neon…");
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
    console.log(`[create-tu-aa] experiment "${key}" already exists in project "${projectId}" — no-op.`);
    return;
  }

  // Insert experiment + variants atomically (non-interactive transaction) — the
  // exact shape lib/store.insertRaw() uses, active = 1 (LIVE, so /api/decide assigns).
  const createdAt = new Date().toISOString();
  const description = (TU_AA.description ?? "").trim();
  await sql.transaction([
    sql`
      INSERT INTO experiment (key, name, business, active, goal_metric, start_date, created_at, description, project_id)
      VALUES (${key}, ${TU_AA.name.trim()}, ${TU_AA.business}, 1, ${TU_AA.goalMetric}, ${TU_AA.startDate}, ${createdAt}, ${description}, ${projectId})
    `,
    ...TU_AA.variants.map(
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
    `[create-tu-aa] created "${row?.key}" (${row?.business}, active=${row?.active}) ` +
      `in project "${projectId}" with ${TU_AA.variants.length} variants (a=control, b — both on tu_lov_uk).`,
  );
  console.log("[create-tu-aa] done. /api/decide will now assign Top Up visitors 50/50; the storefront capture lands in experimentWiring(\"tu-aa-pipeline\").");
}

main().catch((err) => {
  console.error("[create-tu-aa] failed:", err);
  process.exit(1);
});
