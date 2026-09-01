// ============================================================================
// Wasabi — DB-backed experiment store (server-only).
// ----------------------------------------------------------------------------
// The single source of truth for experiments at runtime. Replaces the old static
// lib/experiments.ts array with Postgres-backed rows the management UI can create
// / edit / activate / pause / delete.
//
// Two consumer shapes:
//   1. StoredExperiment  — the flat management contract (lib/mgmt.ts), used by
//      the dashboard UI and server actions.
//   2. RegisteredExperiment — the engine's shape (lib/experiments.ts), adapted
//      from StoredExperiment so assignment (/decide, /flags) and results
//      (metabase.ts, verdict.ts) keep working with zero changes.
//
// SERVER-ONLY: imports lib/db.ts (Neon Postgres). Never import from a client
// component — go through a server action or a server component. All DB access is
// async (serverless Postgres over HTTP), so every public function is a Promise.
// ============================================================================
import { getSql, createSchema } from "./db";
import type { FeatureFlag } from "./engine/types";
import type { RegisteredExperiment } from "./experiments";
import type {
  ExperimentInput,
  StoredExperiment,
  VariantInput,
} from "./mgmt";
import { slugify } from "./mgmt";
import { SEED, SEED_PAUSED } from "./seeds";
import { getCurrentProjectId } from "./tenant";

// ---------------------------------------------------------------------------
// Row shapes (snake_case, as stored)
// ---------------------------------------------------------------------------

interface ExperimentRow {
  key: string;
  name: string;
  business: string;
  active: number;
  goal_metric: string;
  start_date: string;
  created_at: string;
  description: string;
  project_id: string;
}

interface VariantRow {
  experiment_key: string;
  key: string;
  rollout_percentage: number;
  theme_slug: string;
  is_control: number;
  position: number;
}

// ---------------------------------------------------------------------------
// Row → domain mappers
// ---------------------------------------------------------------------------

function toStored(exp: ExperimentRow, variants: VariantRow[]): StoredExperiment {
  const ordered = [...variants].sort((a, b) => a.position - b.position);
  const variantInputs: VariantInput[] = ordered.map((v) => ({
    key: v.key,
    rolloutPercentage: v.rollout_percentage,
    themeSlug: v.theme_slug,
    isControl: v.is_control === 1,
  }));
  const control = ordered.find((v) => v.is_control === 1) ?? ordered[0];
  const themeMap: Record<string, string> = {};
  for (const v of ordered) themeMap[v.key] = v.theme_slug;

  return {
    key: exp.key,
    name: exp.name,
    business: exp.business,
    active: exp.active === 1,
    goalMetric: exp.goal_metric,
    startDate: exp.start_date,
    description: exp.description ?? "",
    createdAt: exp.created_at,
    rolloutPercentage: 100,
    variants: variantInputs,
    controlVariant: control?.key ?? "",
    themeMap,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * All experiments in creation order (seed order preserved), scoped to the
 * current tenant's project. Two round-trips (experiments + their variants)
 * grouped in memory — avoids an N+1 on the /decide hot path.
 *
 * The variant query is JOINed to experiment (rather than a bare
 * `SELECT * FROM variant`) so it never pulls another tenant's variant rows
 * over the wire — `variant` itself carries no project_id (see lib/tenant.ts),
 * so this join IS its tenant filter, not an optimisation.
 */
export async function listExperiments(): Promise<StoredExperiment[]> {
  await ensureReady();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const [expsRaw, varsRaw] = await Promise.all([
    sql`SELECT * FROM experiment WHERE project_id = ${projectId} ORDER BY created_at ASC, key ASC`,
    sql`
      SELECT v.* FROM variant v
      JOIN experiment e ON e.key = v.experiment_key
      WHERE e.project_id = ${projectId}
    `,
  ]);
  const exps = expsRaw as unknown as ExperimentRow[];
  const byExp = new Map<string, VariantRow[]>();
  for (const v of varsRaw as unknown as VariantRow[]) {
    const arr = byExp.get(v.experiment_key);
    if (arr) arr.push(v);
    else byExp.set(v.experiment_key, [v]);
  }
  return exps.map((e) => toStored(e, byExp.get(e.key) ?? []));
}

/** One experiment by key, or undefined — undefined for a key that exists but
 *  belongs to another tenant, same as a key that doesn't exist at all. */
export async function getExperiment(
  key: string,
): Promise<StoredExperiment | undefined> {
  await ensureReady();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const exps = (await sql`SELECT * FROM experiment WHERE key = ${key} AND project_id = ${projectId}`) as unknown as ExperimentRow[];
  const exp = exps[0];
  if (!exp) return undefined;
  // experiment.key is a GLOBAL primary key (see lib/tenant.ts's known-limitation
  // note), so once the row above proves `key` belongs to this tenant, `key` is
  // unambiguous — no other tenant can hold a variant row under the same
  // experiment_key. Safe without its own project_id filter.
  const vars = (await sql`SELECT * FROM variant WHERE experiment_key = ${key} ORDER BY position ASC, key ASC`) as unknown as VariantRow[];
  return toStored(exp, vars);
}

/** True when an experiment with this key already exists IN THIS TENANT. Used
 *  to gate create-vs-conflict — deliberately does not leak whether the key is
 *  taken by another tenant (today there's only one; once there's a global-key
 *  collision risk across tenants, see lib/tenant.ts's known-limitation note,
 *  this still shouldn't reveal a different tenant's key usage). */
export async function experimentExists(key: string): Promise<boolean> {
  await ensureReady();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const rows = (await sql`SELECT 1 AS one FROM experiment WHERE key = ${key} AND project_id = ${projectId}`) as unknown as unknown[];
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Writes — all parameterised; variant set is replaced wholesale on update.
// ---------------------------------------------------------------------------

/** Resolve the persisted key for an input: explicit key, else slug of the name. */
export function resolveKey(input: ExperimentInput): string {
  return (input.key && input.key.trim()) || slugify(input.name);
}

/** Variant INSERT queries for a transaction (collected, not awaited individually).
 *  No project_id filter needed: `variant` inherits tenancy from experiment_key,
 *  which every caller here has JUST inserted (insertRaw) or already verified
 *  belongs to the current tenant (updateExperiment) — see lib/tenant.ts. */
function variantInserts(
  sql: ReturnType<typeof getSql>,
  experimentKey: string,
  variants: VariantInput[],
) {
  return variants.map(
    (v, i) =>
      sql`INSERT INTO variant (experiment_key, key, rollout_percentage, theme_slug, is_control, position)
          VALUES (${experimentKey}, ${v.key}, ${v.rolloutPercentage}, ${v.themeSlug}, ${v.isControl ? 1 : 0}, ${i})`,
  );
}

/** Insert experiment + variants atomically. No readiness guard (used by seeding). */
async function insertRaw(input: ExperimentInput): Promise<string> {
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const key = resolveKey(input);
  const createdAt = new Date().toISOString();
  const description = (input.description ?? "").trim();
  await sql.transaction([
    sql`INSERT INTO experiment (key, name, business, active, goal_metric, start_date, created_at, description, project_id)
        VALUES (${key}, ${input.name.trim()}, ${input.business}, 1, ${input.goalMetric}, ${input.startDate}, ${createdAt}, ${description}, ${projectId})`,
    ...variantInserts(sql, key, input.variants),
  ]);
  return key;
}

/**
 * Persist a brand-new experiment + its variants atomically. Assumes the input
 * has already passed validateInput() and the key is unique (the action checks).
 * Returns the persisted key.
 */
export async function insertExperiment(input: ExperimentInput): Promise<string> {
  await ensureReady();
  return insertRaw(input);
}

/**
 * Update an existing experiment in place. The key is immutable, so `key` is the
 * lookup target and input.key (if present) is ignored for identity. Variants are
 * replaced wholesale. Preserves the original created_at.
 *
 * Ownership is checked BEFORE the transaction, not just via `AND project_id =`
 * on the UPDATE: sql.transaction() sends a non-interactive batch — every
 * statement in it runs regardless of whether an earlier one matched a row. If
 * the UPDATE below were the only guard, a key that exists but belongs to
 * another tenant would leave that UPDATE a no-op yet still run the DELETE +
 * re-INSERT of variants (unconditional, keyed only by experiment_key) —
 * silently overwriting a foreign tenant's variants with this input. The
 * up-front SELECT turns that into a clean no-op instead.
 */
export async function updateExperiment(
  key: string,
  input: ExperimentInput,
): Promise<void> {
  await ensureReady();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const owned = (await sql`SELECT 1 AS one FROM experiment WHERE key = ${key} AND project_id = ${projectId}`) as unknown as unknown[];
  if (owned.length === 0) return; // not found, or owned by another tenant — no-op (caller already 404s via getExperiment)
  const description = (input.description ?? "").trim();
  await sql.transaction([
    sql`UPDATE experiment
          SET name = ${input.name.trim()}, business = ${input.business},
              goal_metric = ${input.goalMetric}, start_date = ${input.startDate},
              description = ${description}
        WHERE key = ${key} AND project_id = ${projectId}`,
    sql`DELETE FROM variant WHERE experiment_key = ${key}`,
    ...variantInserts(sql, key, input.variants),
  ]);
}

/** Flip active on/off. Returns true when a row was affected. No readiness guard.
 *  Tenant-scoped: also called from the seed loop (initOnce) immediately after
 *  insertRaw() creates that same row under the current tenant, so the filter
 *  is correct in both call paths. */
async function setActiveRaw(key: string, active: boolean): Promise<boolean> {
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const rows = (await sql`UPDATE experiment SET active = ${active ? 1 : 0} WHERE key = ${key} AND project_id = ${projectId} RETURNING key`) as unknown as unknown[];
  return rows.length > 0;
}

/** Flip active on/off. Returns true when a row was affected. */
export async function setActive(key: string, active: boolean): Promise<boolean> {
  await ensureReady();
  return setActiveRaw(key, active);
}

/** Delete an experiment (variants cascade via ON DELETE CASCADE — which only
 *  fires when the DELETE below actually matches a row, so a foreign-tenant key
 *  safely deletes nothing). Returns true when a row was removed. */
export async function deleteExperiment(key: string): Promise<boolean> {
  await ensureReady();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const rows = (await sql`DELETE FROM experiment WHERE key = ${key} AND project_id = ${projectId} RETURNING key`) as unknown as unknown[];
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Engine adapter — StoredExperiment → RegisteredExperiment.
// Keeps lib/engine/handlers.ts and lib/metabase.ts working unchanged.
// ---------------------------------------------------------------------------

/**
 * Prefer the experiment's stored description; fall back to an auto-generated
 * summary so legacy / unconfigured experiments still render something useful.
 */
function describe(exp: StoredExperiment): string {
  if (exp.description && exp.description.trim().length > 0) {
    return exp.description.trim();
  }
  const arms = exp.variants.map((v) => v.key).join(" vs ");
  return `${exp.business} experiment (${arms}). Goal metric: ${exp.goalMetric}.`;
}

/** Adapt a StoredExperiment to the engine's RegisteredExperiment shape. */
export function toRegistered(exp: StoredExperiment): RegisteredExperiment {
  const flag: FeatureFlag = {
    key: exp.key,
    active: exp.active,
    rolloutPercentage: exp.rolloutPercentage,
    variants: exp.variants.map((v) => ({
      key: v.key,
      rolloutPercentage: v.rolloutPercentage,
    })),
  };
  return {
    flag,
    name: exp.name,
    description: describe(exp),
    themeMap: exp.themeMap,
    controlVariant: exp.controlVariant,
    startDate: exp.startDate,
    // The live arms ARE the results arms for managed experiments (no retired
    // historical arms tracked in the DB model).
    resultsThemeMap: exp.variants.map((v) => ({
      variant: v.key,
      themeSlug: v.themeSlug,
    })),
  };
}

// ---------------------------------------------------------------------------
// Seed-once — real, editable examples so the app is never blank on a fresh DB.
// Seeds only when the table is empty (so user-deleted seeds don't reappear).
// The SEED data itself lives in lib/seeds.ts so scripts/reseed.ts can re-apply
// it to an already-populated DB without duplicating definitions.
// ---------------------------------------------------------------------------

let readyPromise: Promise<void> | null = null;

/**
 * One-time-per-process readiness: ensure the schema exists, then seed the examples
 * IFF the table is empty (so user-deleted seeds don't reappear). Memoised so
 * concurrent requests share one init; the on-empty seed tolerates a cold-start
 * race (another instance seeding the same keys) by catching the conflict.
 */
function ensureReady(): Promise<void> {
  return (readyPromise ??= initOnce());
}

async function initOnce(): Promise<void> {
  await createSchema();
  const sql = getSql();
  // Scoped to the current tenant's project (not a global COUNT) so seed-once
  // is really "seed once PER PROJECT" — the emptiness check that lets a
  // future onboarding flow apply this same SEED to a brand-new tenant's
  // project without first checking whether some OTHER tenant already has
  // experiments. Today there's one project, so this is equivalent to a
  // global count; see lib/tenant.ts.
  const projectId = await getCurrentProjectId();
  const rows = (await sql`SELECT COUNT(*)::int AS n FROM experiment WHERE project_id = ${projectId}`) as unknown as { n: number }[];
  if ((rows[0]?.n ?? 0) > 0) return;
  // Per-seed isolation: a cold-start race (another instance inserting the same
  // key) fails only that seed, not the rest — so the table still ends up complete
  // rather than permanently partial.
  for (const seed of SEED) {
    try {
      const key = await insertRaw(seed);
      if (SEED_PAUSED.has(key)) await setActiveRaw(key, false);
    } catch (err) {
      console.warn(
        "[wasabi] seed skipped:",
        seed.key,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
