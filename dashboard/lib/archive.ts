// ============================================================================
// Wasabi — archive store (server-only): past experiments imported from other
// platforms (VWO / Wingify first).
// ----------------------------------------------------------------------------
// Unlike the LIVE experiment model (lib/store.ts), an archived run carries its
// RESULTS as stored data — per-variant visitors, conversions, conversion rate,
// uplift and significance — because a historical run on another platform has no
// live payments feed for metabase.ts / verdict.ts to compute from.
//
// SERVER-ONLY: imports lib/db.ts (Neon Postgres). Never import from a client
// component. Upsert is idempotent (delete + re-insert in one transaction), so
// re-running an import overwrites a campaign cleanly instead of duplicating it.
// ============================================================================
import { getSql, createSchema } from "./db";
import { slugify } from "./mgmt";
import { getCurrentProjectId } from "./tenant";
import { isUniqueViolation } from "./users";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type ArchivedStatus = "winner" | "inconclusive" | "lost" | "archived";
export const ARCHIVED_STATUSES: readonly ArchivedStatus[] = [
  "winner",
  "inconclusive",
  "lost",
  "archived",
] as const;

/** One arm of an imported run. Only `key` is required; the rest default. */
export interface ArchivedVariantInput {
  key: string;
  name?: string;
  isControl?: boolean;
  visitors?: number;
  conversions?: number;
  /** % — computed from conversions/visitors when omitted. */
  conversionRate?: number | null;
  /** % uplift vs control — computed vs the control arm when omitted. */
  improvement?: number | null;
  /** significance / chance-to-beat-control, % (0–100). */
  chanceToBeat?: number | null;
  // --- Live payment read (attached from global-api via Metabase). All nullable;
  //     a plain VWO import omits them and they stay null. ---
  /** First-payment auth rate, % — paid / (paid + failed). */
  authRate?: number | null;
  /** Rebill collection rate at cycle 1 (first renewal), %. */
  rebillR1?: number | null;
  /** Rebill collection rate at cycle 2, %. */
  rebillR2?: number | null;
  /** Rebill collection rate at cycle 3, %. */
  rebillR3?: number | null;
  /** Net revenue per acquired customer (GBP) — the "what VWO can't see" number. */
  netRevPerAcquired?: number | null;
}

/** The importer contract — what the VWO/Wingify pull maps each campaign to. */
export interface ArchivedInput {
  key?: string; // slug; derived from name when omitted
  name: string;
  business: string;
  source?: string; // "vwo" | "wingify" | …
  sourceId?: string | null; // platform campaign id
  sourceUrl?: string | null; // deep link to the original report
  type?: string | null; // "A/B" | "Split URL" | "MVT" | …
  status?: ArchivedStatus;
  goalMetric?: string | null; // free text (the platform's primary goal name)
  startDate?: string | null; // ISO
  endDate?: string | null; // ISO
  winnerVariant?: string | null; // variant key
  hypothesis?: string | null;
  notes?: string | null;
  /** The forward-looking learning from this test, post analytics audit. */
  insight?: string | null;
  variants: ArchivedVariantInput[];
}

export interface ArchivedVariant {
  key: string;
  name: string;
  isControl: boolean;
  visitors: number;
  conversions: number;
  conversionRate: number;
  improvement: number | null;
  chanceToBeat: number | null;
  position: number;
  // Live payment read — null until metrics are attached from global-api.
  authRate: number | null;
  rebillR1: number | null;
  rebillR2: number | null;
  rebillR3: number | null;
  netRevPerAcquired: number | null;
}

export interface ArchivedExperiment {
  key: string;
  name: string;
  business: string;
  source: string;
  sourceId: string | null;
  sourceUrl: string | null;
  type: string | null;
  status: ArchivedStatus;
  goalMetric: string | null;
  startDate: string | null;
  endDate: string | null;
  winnerVariant: string | null;
  visitorsTotal: number;
  conversionsTotal: number;
  hypothesis: string;
  notes: string;
  insight: string;
  importedAt: string;
  variants: ArchivedVariant[];
}

// ---------------------------------------------------------------------------
// Row shapes (snake_case, as stored)
// ---------------------------------------------------------------------------

interface ArchivedExperimentRow {
  key: string;
  name: string;
  business: string;
  source: string;
  source_id: string | null;
  source_url: string | null;
  type: string | null;
  status: string;
  goal_metric: string | null;
  start_date: string | null;
  end_date: string | null;
  winner_variant: string | null;
  visitors_total: number;
  conversions_total: number;
  hypothesis: string;
  notes: string;
  insight: string;
  imported_at: string;
  project_id: string;
}

interface ArchivedVariantRow {
  archived_key: string;
  key: string;
  name: string;
  is_control: number;
  visitors: number;
  conversions: number;
  conversion_rate: number;
  improvement: number | null;
  chance_to_beat: number | null;
  position: number;
  auth_rate: number | null;
  rebill_r1: number | null;
  rebill_r2: number | null;
  rebill_r3: number | null;
  net_rev_per_acquired: number | null;
}

// ---------------------------------------------------------------------------
// Normalisation — fill derived fields (CR, uplift, totals) so the importer can
// send only what the platform gives and the store computes the rest.
// ---------------------------------------------------------------------------

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Round to `dp` places, but keep null/undefined as null (nullable metrics). */
function roundOrNull(v: number | null | undefined, dp = 2): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function normalizeVariants(inputs: ArchivedVariantInput[]): ArchivedVariant[] {
  const base: ArchivedVariant[] = inputs.map((v, i) => {
    const visitors = Math.max(0, Math.round(num(v.visitors)));
    const conversions = Math.max(0, Math.round(num(v.conversions)));
    const cr =
      v.conversionRate != null
        ? num(v.conversionRate)
        : visitors > 0
          ? (conversions / visitors) * 100
          : 0;
    return {
      key: v.key,
      name: (v.name ?? "").trim() || v.key,
      isControl: !!v.isControl,
      visitors,
      conversions,
      conversionRate: round2(cr),
      improvement: v.improvement != null ? round2(num(v.improvement)) : null,
      chanceToBeat: v.chanceToBeat != null ? round2(num(v.chanceToBeat)) : null,
      position: i,
      authRate: roundOrNull(v.authRate, 1),
      rebillR1: roundOrNull(v.rebillR1, 1),
      rebillR2: roundOrNull(v.rebillR2, 1),
      rebillR3: roundOrNull(v.rebillR3, 1),
      netRevPerAcquired: roundOrNull(v.netRevPerAcquired, 2),
    };
  });

  // Fill uplift vs the control arm where the platform didn't give it.
  const control = base.find((b) => b.isControl);
  if (control && control.conversionRate > 0) {
    for (const b of base) {
      if (!b.isControl && b.improvement == null) {
        b.improvement = round2(
          ((b.conversionRate - control.conversionRate) /
            control.conversionRate) *
            100,
        );
      }
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// Row → domain
// ---------------------------------------------------------------------------

function toDomain(
  exp: ArchivedExperimentRow,
  variants: ArchivedVariantRow[],
): ArchivedExperiment {
  const ordered = [...variants].sort((a, b) => a.position - b.position);
  const status = (ARCHIVED_STATUSES as readonly string[]).includes(exp.status)
    ? (exp.status as ArchivedStatus)
    : "archived";
  return {
    key: exp.key,
    name: exp.name,
    business: exp.business,
    source: exp.source,
    sourceId: exp.source_id,
    sourceUrl: exp.source_url,
    type: exp.type,
    status,
    goalMetric: exp.goal_metric,
    startDate: exp.start_date,
    endDate: exp.end_date,
    winnerVariant: exp.winner_variant,
    visitorsTotal: exp.visitors_total,
    conversionsTotal: exp.conversions_total,
    hypothesis: exp.hypothesis ?? "",
    notes: exp.notes ?? "",
    insight: exp.insight ?? "",
    importedAt: exp.imported_at,
    variants: ordered.map((v) => ({
      key: v.key,
      name: v.name,
      isControl: v.is_control === 1,
      visitors: v.visitors,
      conversions: v.conversions,
      conversionRate: v.conversion_rate,
      improvement: v.improvement,
      chanceToBeat: v.chance_to_beat,
      position: v.position,
      authRate: v.auth_rate ?? null,
      rebillR1: v.rebill_r1 ?? null,
      rebillR2: v.rebill_r2 ?? null,
      rebillR3: v.rebill_r3 ?? null,
      netRevPerAcquired: v.net_rev_per_acquired ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** All archived experiments, most-recently-run first, scoped to the current
 *  tenant's project. Like lib/store.ts's listExperiments, the variant query is
 *  JOINed to its parent (not a bare `SELECT * FROM archived_variant`) so it
 *  never pulls another tenant's rows over the wire — archived_variant carries
 *  no project_id itself (see lib/tenant.ts), so the join IS its tenant filter. */
export async function listArchived(): Promise<ArchivedExperiment[]> {
  await createSchema();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const [expsRaw, varsRaw] = await Promise.all([
    sql`SELECT * FROM archived_experiment
        WHERE project_id = ${projectId}
        ORDER BY COALESCE(end_date, start_date, imported_at) DESC, name ASC`,
    sql`
      SELECT av.* FROM archived_variant av
      JOIN archived_experiment ae ON ae.key = av.archived_key
      WHERE ae.project_id = ${projectId}
    `,
  ]);
  const exps = expsRaw as unknown as ArchivedExperimentRow[];
  const byExp = new Map<string, ArchivedVariantRow[]>();
  for (const v of varsRaw as unknown as ArchivedVariantRow[]) {
    const arr = byExp.get(v.archived_key);
    if (arr) arr.push(v);
    else byExp.set(v.archived_key, [v]);
  }
  return exps.map((e) => toDomain(e, byExp.get(e.key) ?? []));
}

/** One archived experiment by key, or undefined — undefined for a key that
 *  exists but belongs to another tenant, same as a key that doesn't exist. */
export async function getArchived(
  key: string,
): Promise<ArchivedExperiment | undefined> {
  await createSchema();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const exps = (await sql`SELECT * FROM archived_experiment WHERE key = ${key} AND project_id = ${projectId}`) as unknown as ArchivedExperimentRow[];
  const exp = exps[0];
  if (!exp) return undefined;
  // archived_experiment.key is a GLOBAL primary key (see lib/tenant.ts's
  // known-limitation note), so once the row above proves `key` belongs to
  // this tenant, a plain archived_key lookup can't cross into another
  // tenant's rows. Safe without its own project_id filter.
  const vars = (await sql`SELECT * FROM archived_variant WHERE archived_key = ${key} ORDER BY position ASC`) as unknown as ArchivedVariantRow[];
  return toDomain(exp, vars);
}

/** Count of archived experiments in the current tenant's project. */
export async function countArchived(): Promise<number> {
  await createSchema();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const rows = (await sql`SELECT COUNT(*)::int AS n FROM archived_experiment WHERE project_id = ${projectId}`) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Writes — idempotent upsert (delete + insert, atomic).
// ---------------------------------------------------------------------------

/**
 * Insert-or-replace one archived experiment + its variants. Returns the key.
 *
 * The DELETE is scoped by project_id so re-importing a key that happens to
 * belong to ANOTHER tenant can't touch that tenant's row: it deletes nothing,
 * then the INSERT below hits archived_experiment's PRIMARY KEY (key is
 * GLOBAL — see lib/tenant.ts's known-limitation note) and throws, aborting
 * the transaction — a clean fail-closed rather than a silent cross-tenant
 * overwrite. upsertManyArchived already isolates one bad item from the rest.
 */
export async function upsertArchived(input: ArchivedInput): Promise<string> {
  await createSchema();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const key = (input.key && input.key.trim()) || slugify(input.name);
  const variants = normalizeVariants(input.variants ?? []);
  const visitorsTotal = variants.reduce((s, v) => s + v.visitors, 0);
  const conversionsTotal = variants.reduce((s, v) => s + v.conversions, 0);
  const status =
    input.status && (ARCHIVED_STATUSES as readonly string[]).includes(input.status)
      ? input.status
      : "archived";
  const importedAt = new Date().toISOString();

  await sql.transaction([
    sql`DELETE FROM archived_experiment WHERE key = ${key} AND project_id = ${projectId}`,
    sql`INSERT INTO archived_experiment
          (key, name, business, source, source_id, source_url, type, status,
           goal_metric, start_date, end_date, winner_variant,
           visitors_total, conversions_total, hypothesis, notes, insight, imported_at, project_id)
        VALUES
          (${key}, ${input.name.trim()}, ${input.business}, ${input.source ?? "vwo"},
           ${input.sourceId ?? null}, ${input.sourceUrl ?? null}, ${input.type ?? null}, ${status},
           ${input.goalMetric ?? null}, ${input.startDate ?? null}, ${input.endDate ?? null},
           ${input.winnerVariant ?? null}, ${visitorsTotal}, ${conversionsTotal},
           ${(input.hypothesis ?? "").trim()}, ${(input.notes ?? "").trim()}, ${(input.insight ?? "").trim()}, ${importedAt}, ${projectId})`,
    ...variants.map(
      (v) =>
        sql`INSERT INTO archived_variant
              (archived_key, key, name, is_control, visitors, conversions,
               conversion_rate, improvement, chance_to_beat, position,
               auth_rate, rebill_r1, rebill_r2, rebill_r3, net_rev_per_acquired)
            VALUES
              (${key}, ${v.key}, ${v.name}, ${v.isControl ? 1 : 0}, ${v.visitors}, ${v.conversions},
               ${v.conversionRate}, ${v.improvement}, ${v.chanceToBeat}, ${v.position},
               ${v.authRate}, ${v.rebillR1}, ${v.rebillR2}, ${v.rebillR3}, ${v.netRevPerAcquired})`,
    ),
  ]);
  return key;
}

export interface ImportResult {
  imported: string[];
  failed: { name: string; error: string }[];
}

/** Upsert many; per-item isolation so one bad campaign doesn't sink the batch. */
export async function upsertManyArchived(
  inputs: ArchivedInput[],
): Promise<ImportResult> {
  const imported: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const input of inputs) {
    try {
      imported.push(await upsertArchived(input));
    } catch (err) {
      // archived_experiment.key is a GLOBAL primary key across tenants (see
      // lib/tenant.ts's KNOWN LIMITATION note) and upsertArchived's own DELETE
      // is project-scoped, so a unique-violation here can ONLY mean the key
      // belongs to a DIFFERENT tenant (a same-tenant re-import deletes its own
      // row first, so it never conflicts — see upsertArchived's header
      // comment). The raw Postgres message names the key, which would confirm
      // to this caller that some other tenant already owns it — genericise
      // it. Any other failure keeps its real message.
      failed.push({
        name: input?.name ?? "(unnamed)",
        error: isUniqueViolation(err)
          ? "That experiment key is already in use — pick another."
          : err instanceof Error
            ? err.message
            : String(err),
      });
    }
  }
  return { imported, failed };
}

// ---------------------------------------------------------------------------
// Writes — attach the live payment read onto an already-imported experiment.
// ---------------------------------------------------------------------------

/** The payment metrics computed for one archived variant (all nullable). */
export interface VariantPaymentMetrics {
  /** The archived_variant key to write onto. */
  key: string;
  authRate: number | null;
  rebillR1: number | null;
  rebillR2: number | null;
  rebillR3: number | null;
  netRevPerAcquired: number | null;
}

/**
 * Attach payment metrics onto an existing archived experiment's variants —
 * an in-place UPDATE per variant, so the imported VWO data (visitors,
 * conversions, uplift) is untouched. Non-matching keys are skipped silently.
 * Returns the variant keys that were actually written.
 *
 * Unlike getArchived/upsertArchived, this entry point takes `archivedKey`
 * with no prior tenant-scoped lookup in the same call, and archived_variant
 * itself carries no project_id (see lib/tenant.ts) — so without the ownership
 * check below, a caller could attach payment data onto another tenant's
 * archived_variant rows. Checked up front (not folded into each UPDATE's
 * WHERE) for the same non-interactive-transaction reason as
 * lib/store.ts's updateExperiment: a per-statement filter would leave the
 * UPDATEs a silent no-op for a foreign key rather than refusing the whole call.
 */
export async function attachPaymentMetrics(
  archivedKey: string,
  metrics: VariantPaymentMetrics[],
): Promise<string[]> {
  await createSchema();
  const sql = getSql();
  if (metrics.length === 0) return [];
  const projectId = await getCurrentProjectId();
  const owned = (await sql`SELECT 1 AS one FROM archived_experiment WHERE key = ${archivedKey} AND project_id = ${projectId}`) as unknown as unknown[];
  if (owned.length === 0) return []; // not found, or owned by another tenant

  const statements = metrics.map(
    (m) =>
      sql`UPDATE archived_variant
            SET auth_rate            = ${roundOrNull(m.authRate, 1)},
                rebill_r1            = ${roundOrNull(m.rebillR1, 1)},
                rebill_r2            = ${roundOrNull(m.rebillR2, 1)},
                rebill_r3            = ${roundOrNull(m.rebillR3, 1)},
                net_rev_per_acquired = ${roundOrNull(m.netRevPerAcquired, 2)}
          WHERE archived_key = ${archivedKey} AND key = ${m.key}
          RETURNING key`,
  );
  const results = (await sql.transaction(statements)) as unknown as Array<
    { key: string }[]
  >;
  return results.flatMap((rows) => rows.map((r) => r.key));
}

/**
 * Set the free-text insight on an archived experiment — an in-place UPDATE that
 * touches nothing else (variants, imported VWO figures and any attached payment
 * metrics are left intact). This is the non-destructive path: re-importing would
 * cascade-delete the variants and wipe the payment read, so the insight, written
 * after an analytics audit, goes through here instead. Returns true if the row
 * existed (and belongs to the current tenant).
 */
export async function setArchivedInsight(
  key: string,
  insight: string,
): Promise<boolean> {
  await createSchema();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const rows = (await sql`UPDATE archived_experiment
                            SET insight = ${insight.trim()}
                          WHERE key = ${key} AND project_id = ${projectId}
                          RETURNING key`) as unknown as unknown[];
  return rows.length > 0;
}

/** Delete one archived experiment (variants cascade via ON DELETE CASCADE —
 *  which only fires when the DELETE below actually matches a row). */
export async function deleteArchived(key: string): Promise<boolean> {
  await createSchema();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const rows = (await sql`DELETE FROM archived_experiment WHERE key = ${key} AND project_id = ${projectId} RETURNING key`) as unknown as unknown[];
  return rows.length > 0;
}
