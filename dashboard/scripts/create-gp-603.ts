// ============================================================================
// scripts/create-gp-603.ts — one-off: register GP-603 as a LIVE (active)
// experiment in Wasabi, scoped to the Sanjow org / default project, so
// /api/decide assigns every Top Up visitor to one of five arms and the
// storefront can apply that arm through the &var= URL parameter.
// Modelled EXACTLY on scripts/create-tu-aa.ts — same guards, same validation,
// same INSERT shape, same org/project scoping. Updated for the develop schema:
// the experiment INSERT carries youtrack_ticket (added by PR #9).
// ----------------------------------------------------------------------------
// THE EXPERIMENT: GP-603 is a SPLIT-URL test on the Top Up storefront. Five
// arms show the promo message five different ways — control (the current
// display) vs static, rotate, marquee, ticker. Even 20% split, active so
// /api/decide assigns from the first visitor.
//
// THE &var= CONTRACT (documented here because it drives arm setup):
//   /api/decide (app/api/decide/route.ts → lib/engine/handlers.handleDecide)
//   returns, for this experiment key, featureFlags["gp-603"] = the assigned
//   VARIANT KEY — one of "control" / "static" / "rotate" / "marquee" /
//   "ticker" (lib/engine/assignment.getFeatureFlag walks the cumulative
//   rollout buckets and returns variant.key). That variant key IS the
//   identifier the storefront proxy appends as &var=<value>. The five variant
//   keys are therefore the contract with the storefront: whatever /api/decide
//   returns is what the storefront renders.
//
//   THE SPLIT-URL THEME DECISION: this is NOT a theme-slug test. A real theme
//   A/B (see lib/seeds.ts: tu_lov_uk vs tu_lov_uk_19) maps each arm to a
//   distinct global-api Theme slug and lets a ?theme= redirect change the
//   page. GP-603 instead tells arms apart by the &var= parameter, so there is
//   no real theme to point at — and inventing one would (a) pin a locale /
//   currency via a ?theme= redirect (proxy THEME_TO_LOCALE) and (b) claim a
//   global-api Theme slug this test does not own. But lib/mgmt.validateInput
//   REQUIRES every arm to carry a non-empty theme slug matching THEME_SLUG_RE
//   (a lower-case token, 2-50 chars) — the column is NOT NULL. So each arm's
//   themeSlug is set to its OWN variant value ("control", "static", …). That
//   is the split-URL convention here: the theme field doubles as the arm
//   identifier. It makes lib/store.toRegistered build themeMap[value] = value,
//   so handleDecide's themes["gp-603"] echoes the SAME variant value as
//   featureFlags["gp-603"] — the &var= value is unambiguous whichever field
//   the storefront reads. VARIANT PRIMARY KEY is (experiment_key, key), never
//   theme_slug (lib/db.ts), so nothing here needs the slug to be unique.
//
//   RESULTS: the goal metric is "conversions" (lib/seeds.SEED_METRICS — the
//   Conversions goal added by PR #9, backed by VariantRow.adConversions /
//   gAdsConversion.converted). Ad-conversion attribution joins by theme slug,
//   so a per-arm result appears once the storefront tags its ad-conversion
//   rows with the same &var= value it renders; until then each arm reads the
//   empty state, which the results table renders cleanly — the same
//   "assignment side proves out first, payment/ads side fills in" pattern as
//   the TU A/A and the GP-600 PDF split-URL pilot. The ASSIGNMENT side is live
//   from the first visitor via /api/capture (variant key off &var=).
//
// WHY NOT the app's own create path (lib/store.insertExperiment): that resolves
// the target project through getCurrentProjectId() → getCurrentTenant() →
// resolveTenantOrgId(), which does a dynamic `import("@/auth")` (next-auth,
// transitively next/server). That only resolves under Next's bundler with a
// live request/session — NOT under the plain `node --experimental-strip-types`
// loader this script runs under (the ts-resolve hook maps relative `.ts`
// imports only, never the `@/` alias — see scripts/ts-resolve-hook.mjs and
// lib/tenant.ts's "DYNAMIC IMPORTS, DELIBERATELY" note). So this script scopes
// EXPLICITLY to the SANJOW_DEFAULT_PROJECT_ID constant — exactly how
// scripts/create-tu-aa.ts and scripts/migrate-tenancy.ts write their
// org/project/experiment rows — while still reusing the app's own invariants:
// lib/mgmt.validateInput() (splits sum to 100, exactly one control, valid
// keys/slugs, ≥2 variants) against the app's own goal-metric registry
// (lib/seeds.SEED_METRICS), and the exact INSERT shape lib/store.insertRaw()
// uses on develop (including youtrack_ticket).
//
// IDEMPOTENT: check-if-exists (scoped to key + project) before writing, so a
// re-run is a clean no-op. createSchema() is idempotent; the org/project rows
// are ON CONFLICT DO NOTHING; the experiment + variants are inserted in one
// non-interactive transaction only when the key is absent.
//
// SAFETY (prod-targeted — the mirror image of scripts/migrate-tenancy.ts, which
// is LOCAL-only): refuses to run against the local Postgres proxy
// (USE_LOCAL_PG=1), requires DATABASE_URL (or POSTGRES_URL), and requires an
// explicit CONFIRM_CREATE_GP_603=1 before any write. It prints only the target
// DB host, never the connection string / credentials. lib/db.ts's getSql()
// speaks Neon over HTTP whenever USE_LOCAL_PG is unset, so this targets Neon.
//
// Safe to commit un-run: with none of the env vars set, importing/executing
// this file exits(2) before opening a single DB connection.
//
// Run from `dashboard/` (Srikant owns the prod run — or create GP-603 from the
// dashboard's own /experiments/new page instead):
//   DATABASE_URL='postgres://…' CONFIRM_CREATE_GP_603=1 \
//     node --experimental-strip-types --no-warnings \
//       --import ./scripts/ts-resolve-hook-register.mjs scripts/create-gp-603.ts
//   (or: DATABASE_URL='…' CONFIRM_CREATE_GP_603=1 npm run create:gp-603)
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
// The experiment to create — gp-603 (Top Up promo-banner display style).
// ---------------------------------------------------------------------------
// Five arms, even 20% split, control = the current display. Each arm's
// themeSlug is its OWN variant value (the split-URL convention above), so the
// theme field carries the arm identifier rather than a real global-api Theme.
// active: true — LIVE, so /api/decide assigns from the first visitor.
// youtrackTicket: "GP-603" — stored on the experiment row (PR #9 column),
// surfaced as the "Ticket ↗" link on the detail page.
const GP_603: ExperimentInput = {
  name: "TU — Promo banner display style (split-URL)",
  key: "gp-603",
  business: "Top Up",
  goalMetric: "conversions",
  startDate: "2026-09-07",
  youtrackTicket: "GP-603",
  active: true,
  description:
    "Split-URL test on the Top Up storefront: five ways of showing the promo message — control (current) vs static, rotate, marquee, ticker. Arms are applied by the &var= URL parameter appended from /api/decide, not by a theme redirect, so every visitor keeps their own locale and currency. Even 20% split, active from the first visitor.",
  variants: [
    { key: "control", rolloutPercentage: 20, themeSlug: "control", isControl: true },
    { key: "static", rolloutPercentage: 20, themeSlug: "static", isControl: false },
    { key: "rotate", rolloutPercentage: 20, themeSlug: "rotate", isControl: false },
    { key: "marquee", rolloutPercentage: 20, themeSlug: "marquee", isControl: false },
    { key: "ticker", rolloutPercentage: 20, themeSlug: "ticker", isControl: false },
  ],
};

// ---------------------------------------------------------------------------
// Safety guards — run before any DB connection (getSql() is lazy).
// ---------------------------------------------------------------------------
if (process.env.USE_LOCAL_PG === "1") {
  console.error("[create-gp-603] refusing to run: USE_LOCAL_PG=1 is set.");
  console.error("[create-gp-603] this script targets the deployed Neon DB, not the local Postgres proxy.");
  console.error("[create-gp-603] unset USE_LOCAL_PG and set DATABASE_URL to the prod connection string.");
  process.exit(2);
}

const dbUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!dbUrl || dbUrl.trim().length === 0) {
  console.error("[create-gp-603] DATABASE_URL (or POSTGRES_URL) must be set to the target Neon connection string.");
  console.error("[create-gp-603] `vercel env pull` does NOT export the Vercel-Neon integration vars — copy the");
  console.error("[create-gp-603] connection string from the Neon Console.");
  process.exit(2);
}

if (process.env.CONFIRM_CREATE_GP_603 !== "1") {
  console.error("[create-gp-603] refusing to run: set CONFIRM_CREATE_GP_603=1 to confirm a write to the target DB.");
  console.error("[create-gp-603] (re-running after gp-603 already exists is a safe no-op, but the confirm is still required.)");
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
console.log(`[create-gp-603] target DB host: ${dbHost(dbUrl)}`);

// ---------------------------------------------------------------------------
// Validate the definition against the app's own invariants before connecting.
// ---------------------------------------------------------------------------
const allowedGoalMetrics = SEED_METRICS.filter((m) => m.isGoal).map((m) => m.key);
const validationError = validateInput(GP_603, allowedGoalMetrics);
if (validationError) {
  console.error(`[create-gp-603] definition failed validation: ${validationError}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const key = GP_603.key!;
  const projectId = SANJOW_DEFAULT_PROJECT_ID;

  console.log("[create-gp-603] connecting to Neon…");
  await createSchema(); // idempotent — organization / project / experiment / variant tables.
  const sql = getSql();

  // Ensure the org + default project rows exist (the FK target for
  // experiment.project_id). Idempotent — the same statements
  // scripts/migrate-tenancy.ts uses. On a prod DB where the tenancy migration
  // already ran these are no-ops.
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
    console.log(`[create-gp-603] experiment "${key}" already exists in project "${projectId}" — no-op.`);
    return;
  }

  // Insert experiment + variants atomically (non-interactive transaction) — the
  // exact shape lib/store.insertRaw() uses on develop (youtrack_ticket column
  // included), active = 1 (LIVE, so /api/decide assigns).
  const createdAt = new Date().toISOString();
  const description = (GP_603.description ?? "").trim();
  const youtrackTicket = (GP_603.youtrackTicket ?? "").trim() || null;
  await sql.transaction([
    sql`
      INSERT INTO experiment (key, name, business, active, goal_metric, start_date, created_at, description, youtrack_ticket, project_id)
      VALUES (${key}, ${GP_603.name.trim()}, ${GP_603.business}, 1, ${GP_603.goalMetric}, ${GP_603.startDate}, ${createdAt}, ${description}, ${youtrackTicket}, ${projectId})
    `,
    ...GP_603.variants.map(
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
    `[create-gp-603] created "${row?.key}" (${row?.business}, active=${row?.active}) ` +
      `in project "${projectId}" with ${GP_603.variants.length} variants ` +
      `(control, static, rotate, marquee, ticker — 20% each, split-URL via &var=).`,
  );
  console.log("[create-gp-603] done. /api/decide will now assign Top Up visitors 20/20/20/20/20; the storefront appends &var=<variant> per assignment.");
}

main().catch((err) => {
  console.error("[create-gp-603] failed:", err);
  process.exit(1);
});
