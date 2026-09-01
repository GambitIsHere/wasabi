// ============================================================================
// Wasabi — admin reseed logic (shared by the CLI script and the /admin/reseed
// API route). DESTRUCTIVE: wipes the experiment + variant tables, then
// re-applies the canonical SEED from lib/seeds.ts.
// ----------------------------------------------------------------------------
// SERVER-ONLY (imports lib/db.ts).
//
// TENANCY: scoped to the current tenant's project throughout — this wipes
// and re-seeds ONE project's experiments, never another tenant's, even though
// SEED itself is Sanjow-specific demo data. Found via lib/tenant-scoping.test.ts's
// dynamic file scan (it imports getSql like the other data modules) while
// building the tenancy seam — before that this DELETE'd every tenant's rows.
// ============================================================================
import { getSql, createSchema } from "./db";
import { SEED, SEED_PAUSED } from "./seeds";
import { getCurrentProjectId } from "./tenant";

export interface ReseedResult {
  /** Rows in `experiment` before the wipe. */
  before: number;
  /** Rows in `experiment` after the reseed. */
  after: number;
  /** ISO timestamp when the reseed ran. */
  ranAt: string;
  /** Per-experiment outcome, in seed order. */
  experiments: Array<{ key: string; name: string; active: boolean }>;
}

/**
 * Wipe + re-apply SEED. Ensures the schema first (idempotent), so this works
 * against an older DB that pre-dates the description column.
 *
 * Atomicity caveat: the wipe and inserts are not in a single transaction —
 * the Neon HTTP driver in this project doesn't expose transactions at the API
 * level for the variant of calls we use. In practice the operation is fast
 * (≤1s for ~6 experiments) and only runs from authenticated admin contexts;
 * if it fails mid-way the resulting state is a partial seed that the operator
 * can simply re-run. We document this here so future readers don't add a fake
 * transaction wrapper that doesn't actually atomicise.
 */
export async function applySeed(): Promise<ReseedResult> {
  await createSchema();
  const sql = getSql();
  const projectId = await getCurrentProjectId();

  const beforeRows = (await sql`SELECT COUNT(*)::int AS n FROM experiment WHERE project_id = ${projectId}`) as unknown as { n: number }[];
  const before = beforeRows[0]?.n ?? 0;

  // variant carries no project_id of its own (see lib/tenant.ts) — scope the
  // wipe through its parent's key instead of a bare DELETE FROM variant,
  // which would take out every OTHER tenant's variants too.
  await sql`DELETE FROM variant WHERE experiment_key IN (SELECT key FROM experiment WHERE project_id = ${projectId})`;
  await sql`DELETE FROM experiment WHERE project_id = ${projectId}`;

  const ranAt = new Date().toISOString();
  const experiments: ReseedResult["experiments"] = [];

  for (const exp of SEED) {
    const key = exp.key;
    if (!key) continue;
    const active = SEED_PAUSED.has(key) ? 0 : 1;
    const description = (exp.description ?? "").trim();

    await sql`
      INSERT INTO experiment (key, name, business, active, goal_metric, start_date, created_at, description, project_id)
      VALUES (${key}, ${exp.name.trim()}, ${exp.business}, ${active}, ${exp.goalMetric}, ${exp.startDate}, ${ranAt}, ${description}, ${projectId})
    `;
    for (let i = 0; i < exp.variants.length; i++) {
      const v = exp.variants[i]!;
      // No project_id needed on variant — experiment_key above was just
      // inserted under projectId in this same request, so it's already
      // unambiguous (experiment.key is a global primary key).
      await sql`
        INSERT INTO variant (experiment_key, key, rollout_percentage, theme_slug, is_control, position)
        VALUES (${key}, ${v.key}, ${v.rolloutPercentage}, ${v.themeSlug}, ${v.isControl ? 1 : 0}, ${i})
      `;
    }
    experiments.push({ key, name: exp.name, active: active === 1 });
  }

  const afterRows = (await sql`SELECT COUNT(*)::int AS n FROM experiment WHERE project_id = ${projectId}`) as unknown as { n: number }[];
  const after = afterRows[0]?.n ?? 0;

  return { before, after, ranAt, experiments };
}
