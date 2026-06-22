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
 * All experiments in creation order (seed order preserved). Two round-trips
 * (experiments + all variants) grouped in memory — avoids an N+1 on the /decide
 * hot path.
 */
export async function listExperiments(): Promise<StoredExperiment[]> {
  await ensureReady();
  const sql = getSql();
  const [expsRaw, varsRaw] = await Promise.all([
    sql`SELECT * FROM experiment ORDER BY created_at ASC, key ASC`,
    sql`SELECT * FROM variant`,
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

/** One experiment by key, or undefined. */
export async function getExperiment(
  key: string,
): Promise<StoredExperiment | undefined> {
  await ensureReady();
  const sql = getSql();
  const exps = (await sql`SELECT * FROM experiment WHERE key = ${key}`) as unknown as ExperimentRow[];
  const exp = exps[0];
  if (!exp) return undefined;
  const vars = (await sql`SELECT * FROM variant WHERE experiment_key = ${key} ORDER BY position ASC, key ASC`) as unknown as VariantRow[];
  return toStored(exp, vars);
}

/** True when an experiment with this key already exists. */
export async function experimentExists(key: string): Promise<boolean> {
  await ensureReady();
  const sql = getSql();
  const rows = (await sql`SELECT 1 AS one FROM experiment WHERE key = ${key}`) as unknown as unknown[];
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Writes — all parameterised; variant set is replaced wholesale on update.
// ---------------------------------------------------------------------------

/** Resolve the persisted key for an input: explicit key, else slug of the name. */
export function resolveKey(input: ExperimentInput): string {
  return (input.key && input.key.trim()) || slugify(input.name);
}

/** Variant INSERT queries for a transaction (collected, not awaited individually). */
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
  const key = resolveKey(input);
  const createdAt = new Date().toISOString();
  await sql.transaction([
    sql`INSERT INTO experiment (key, name, business, active, goal_metric, start_date, created_at)
        VALUES (${key}, ${input.name.trim()}, ${input.business}, 1, ${input.goalMetric}, ${input.startDate}, ${createdAt})`,
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
 */
export async function updateExperiment(
  key: string,
  input: ExperimentInput,
): Promise<void> {
  await ensureReady();
  const sql = getSql();
  await sql.transaction([
    sql`UPDATE experiment
          SET name = ${input.name.trim()}, business = ${input.business},
              goal_metric = ${input.goalMetric}, start_date = ${input.startDate}
        WHERE key = ${key}`,
    sql`DELETE FROM variant WHERE experiment_key = ${key}`,
    ...variantInserts(sql, key, input.variants),
  ]);
}

/** Flip active on/off. Returns true when a row was affected. No readiness guard. */
async function setActiveRaw(key: string, active: boolean): Promise<boolean> {
  const sql = getSql();
  const rows = (await sql`UPDATE experiment SET active = ${active ? 1 : 0} WHERE key = ${key} RETURNING key`) as unknown as unknown[];
  return rows.length > 0;
}

/** Flip active on/off. Returns true when a row was affected. */
export async function setActive(key: string, active: boolean): Promise<boolean> {
  await ensureReady();
  return setActiveRaw(key, active);
}

/** Delete an experiment (variants cascade). Returns true when a row was removed. */
export async function deleteExperiment(key: string): Promise<boolean> {
  await ensureReady();
  const sql = getSql();
  const rows = (await sql`DELETE FROM experiment WHERE key = ${key} RETURNING key`) as unknown as unknown[];
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Engine adapter — StoredExperiment → RegisteredExperiment.
// Keeps lib/engine/handlers.ts and lib/metabase.ts working unchanged.
// ---------------------------------------------------------------------------

/** A short human description derived from the stored fields. */
function describe(exp: StoredExperiment): string {
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
// ---------------------------------------------------------------------------

let readyPromise: Promise<void> | null = null;

const SEED: ExperimentInput[] = [
  {
    name: "Top-Up Billing UK",
    key: "tu-billing-uk",
    business: "Top Up",
    goalMetric: "revenue_per_acquired",
    startDate: "2026-05-07",
    variants: [
      { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
      { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
    ],
  },
  {
    name: "Top-Up Reward Page",
    key: "tu-reward-page",
    business: "Top Up",
    goalMetric: "revenue_per_acquired",
    startDate: "2026-05-07",
    variants: [
      { key: "a", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
      { key: "b", rolloutPercentage: 50, themeSlug: "tu_lov_ie_serenity", isControl: false },
    ],
  },
  {
    // AC-AB-002 (GP-54) — biweekly 24.9 vs quarterly 79. Seeded PAUSED below:
    // verify the config in the UI, then hit Activate to start it.
    name: "AC — Biweekly 24.9 vs Quarterly 79",
    key: "ac-billing-24-9",
    business: "Airport Check-In",
    goalMetric: "revenue_per_acquired",
    startDate: "2026-06-19",
    variants: [
      { key: "control", rolloutPercentage: 50, themeSlug: "ac_mto_lov", isControl: true },
      { key: "variant_24_9", rolloutPercentage: 50, themeSlug: "ac_mto_lov_24_9", isControl: false },
    ],
  },
  {
    // AS (Airport Security / fast-track). PROPOSED price test — slugs are real
    // Theme-table slugs. NOTE: fast-track drives price via a ?product=_1m_NN param,
    // NOT the theme suffix, so its middleware sets ?product= AND ?theme= (the theme
    // is the attribution tag). See integration/storefronts/. Verify the test design
    // + prices with product before activating.
    name: "AS — Fast-Track £19 vs £14 (1-month)",
    key: "as-billing-1m",
    business: "Airport Security",
    goalMetric: "revenue_per_acquired",
    startDate: "2026-06-22",
    variants: [
      { key: "control", rolloutPercentage: 50, themeSlug: "as_sub_1m_19", isControl: true },
      { key: "variant_14", rolloutPercentage: 50, themeSlug: "as_sub_lov_1m_14", isControl: false },
    ],
  },
  {
    // PDF SaaS. PROPOSED price test — real Theme-table slugs (price encoded in the
    // theme: auth49 = £49, auth19 = £19). Verify the test design with product
    // before activating.
    name: "PDF — £49 vs £19 (auth price)",
    key: "pdf-price-49-19",
    business: "PDF SaaS",
    goalMetric: "revenue_per_acquired",
    startDate: "2026-06-22",
    variants: [
      { key: "control", rolloutPercentage: 50, themeSlug: "pdf_auth49", isControl: true },
      { key: "variant_19", rolloutPercentage: 50, themeSlug: "pdf_auth19", isControl: false },
    ],
  },
];

/** Keys that ship seeded but PAUSED — verify config, then Activate from the UI. */
const SEED_PAUSED = new Set<string>([
  "ac-billing-24-9",
  "as-billing-1m",
  "pdf-price-49-19",
]);

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
  const rows = (await sql`SELECT COUNT(*)::int AS n FROM experiment`) as unknown as { n: number }[];
  if ((rows[0]?.n ?? 0) > 0) return;
  try {
    for (const seed of SEED) {
      const key = await insertRaw(seed);
      if (SEED_PAUSED.has(key)) await setActiveRaw(key, false);
    }
  } catch (err) {
    // Likely a concurrent instance seeded the same keys first — that's fine.
    console.warn(
      "[wasabi] seed skipped/partial:",
      err instanceof Error ? err.message : err,
    );
  }
}
