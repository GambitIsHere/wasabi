// ============================================================================
// Wasabi dashboard — Metabase client (live per-variant P&L)
// ----------------------------------------------------------------------------
// Runs the validated per-variant results query against the global-api Postgres,
// fronted by Metabase ("MAIN DB - Production"), via Metabase's native-query
// dataset API. Ported from decision-helper/results.sql + run.ts, but talks HTTP
// to Metabase instead of shelling out to mb-query.sh.
//
// CONTRACT:
//   - Resolves the "MAIN DB - Production" database id via GET /api/database.
//   - POSTs the native SQL to /api/dataset with header `x-api-key`.
//   - SELECT/CTE only — never mutates.
//   - Degrades gracefully: if METABASE_API_KEY is unset it returns
//     { available: false, reason } and NEVER throws, so the UI renders a clean
//     empty-state with or without the key.
// ============================================================================
import type { RegisteredExperiment } from "./experiments";
import { THEME_SLUG_RE } from "./mgmt";
import type { VariantRow } from "./verdict";

/** The Metabase database whose name we resolve to an id. */
const MAIN_DB_NAME = "MAIN DB - Production";

/** Discriminated result so callers can branch on `available` without try/catch. */
export type ResultsOutcome =
  | { available: true; rows: VariantRow[] }
  | { available: false; reason: string };

// ---------------------------------------------------------------------------
// SQL builder — ported from decision-helper/run.ts (adds raw first_failed so
// the auth-rate denominator is exact, not reconstructed from the rounded %).
//
// R1–R3 rebill split: the flat `rebill_rate` above lumps every renewal attempt
// together. The `rebill_ranked` / `rebill_cycle` CTEs below rank each
// subscription's rebill attempts into cycles (1st, 2nd, 3rd) and report the
// success rate at each cycle — so a test that changes dunning or retry timing
// shows where in the renewal life the money is won or lost.
// ---------------------------------------------------------------------------

// Single source of truth for the Transaction creation-timestamp column. This is
// the FIRST place the payment query reads a Transaction timestamp — the flat
// P&L columns never needed one. VERIFIED against global-api/prisma/schema.prisma:
// Transaction."createdAt" (indexed) and PK "transactionId" both exist. If the
// schema ever renames them, change it HERE only; every rebill ordering flows through.
const TX_CREATED_AT = "createdAt";

// ---------------------------------------------------------------------------
// Input validation — the primary guard for resultsSql() below, NOT the
// quote-escaping it also does. This query runs as Metabase native SQL against
// "MAIN DB - Production" — the SHARED, LIVE PAYMENTS DATABASE — and its slug +
// date-window inputs now originate from request bodies (e.g.
// app/api/admin/attach-payment/route.ts's `slugMap` and `window.start` /
// `window.end`, which arrive as bare strings checked only for `typeof ===
// "string"`). Escaping `'` → `''` stops a value from breaking OUT of its
// string literal, but a strict allow-list checked BEFORE interpolation is
// what actually keeps an arbitrary caller-supplied string from ever reaching
// that database, so callers get a clean rejection instead of leaning on
// escaping alone. Checked here — the one place every caller of the query path
// (runResults, runPaymentMetrics; see resultsSql's callers below) funnels
// through — rather than in just one route.
// ---------------------------------------------------------------------------

/**
 * A theme slug is valid Metabase query input iff it's a valid Theme.slug
 * shape — reuses lib/mgmt.ts's THEME_SLUG_RE so the management form (which
 * writes these slugs) and this production-DB read enforce EXACTLY the same
 * rule, not two rules that can drift apart.
 */
export function isValidThemeSlug(slug: string): boolean {
  return THEME_SLUG_RE.test(slug);
}

/**
 * Strict ISO-8601 date ("2026-09-01") or datetime ("2026-09-01T00:00:00.000Z",
 * offset or "Z", optional milliseconds) — the only shapes resultsSql() ever
 * embeds as a `TIMESTAMP '…'` literal. Regex-only (no calendar-correctness
 * check, e.g. "2026-02-30" still matches), matching the same tradeoff
 * lib/mgmt.ts's own ISO_DATE_RE already makes for experiment.startDate — a
 * regex-valid-but-nonexistent date fails harmlessly at Postgres's own
 * TIMESTAMP cast instead of ever being a query-shape risk.
 */
const ISO_DATE_OR_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/;

export function isValidDateInput(value: string): boolean {
  return ISO_DATE_OR_DATETIME_RE.test(value);
}

/**
 * Reject (throw) on the first slug or date that doesn't match the allow-list,
 * BEFORE resultsSql() below builds so much as one line of SQL text from it.
 * Called at the very top of resultsSql() — see that function and this
 * section's header comment for why validation lives here rather than only in
 * one caller's route handler.
 */
function assertValidQueryInputs(
  slugs: readonly string[],
  start: string,
  end?: string,
): void {
  for (const slug of slugs) {
    if (!isValidThemeSlug(slug)) {
      throw new Error(`Refusing to query Metabase: invalid theme slug "${slug}".`);
    }
  }
  if (!isValidDateInput(start)) {
    throw new Error(
      `Refusing to query Metabase: invalid start date "${start}" (expected ISO-8601).`,
    );
  }
  if (end !== undefined && !isValidDateInput(end)) {
    throw new Error(
      `Refusing to query Metabase: invalid end date "${end}" (expected ISO-8601).`,
    );
  }
}

function resultsSql(
  slugs: readonly string[],
  start: string,
  end?: string,
): string {
  // PRIMARY guard — see this section's header comment. Throws on anything
  // that doesn't match the allow-list, before any interpolation below runs.
  assertValidQueryInputs(slugs, start, end);
  // Defense-in-depth ONLY from here down: slugs/start/end are now known to
  // match a strict allow-list, but every literal is still quoted so a valid
  // slug/date can never itself break out of its SQL string context.
  const slugList = slugs.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ");
  const startLiteral = start.replace(/'/g, "''");
  const ts = `"${TX_CREATED_AT}"`;
  const appEnd = end
    ? `\n    AND a."createdAt" < TIMESTAMP '${end.replace(/'/g, "''")}'`
    : "";
  const adsEnd = end
    ? `\n    AND g."createdAt" < TIMESTAMP '${end.replace(/'/g, "''")}'`
    : "";
  return `
WITH variant AS (
  SELECT
    th."slug"          AS theme_slug,
    a."applicationId"  AS application_id
  FROM "Application" a
  JOIN "Theme" th ON th."themeId" = a."themeId"
  WHERE th."slug" IN (${slugList})
    AND a."createdAt" >= TIMESTAMP '${startLiteral}'${appEnd}
),
tx AS (
  SELECT
    v.theme_slug,
    v.application_id,
    t."type"      AS tx_type,
    t."amountGBP" AS amount_gbp,
    t."amount"    AS amount_native,
    t."currency"  AS ccy
  FROM variant v
  LEFT JOIN "Transaction" t ON t."applicationId" = v.application_id
),
rebill_ranked AS (
  -- Rank each subscription's rebill attempts into cycles R1, R2, R3, …
  -- Partitioning is by SUBSCRIPTION (the correct renewal grain — mirrors the
  -- deduped block in decision-helper/results.sql), falling back to the
  -- application when "subscriptionId" is null so no rebill row is dropped.
  -- Ordering by the tx timestamp then id makes the cycle numbering deterministic.
  SELECT
    v.theme_slug,
    t."type" AS tx_type,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(t."subscriptionId"::text, v.application_id::text)
      ORDER BY t.${ts}, t."transactionId"
    ) AS cycle
  FROM variant v
  JOIN "Transaction" t ON t."applicationId" = v.application_id
  WHERE t."type" IN ('rebill', 'rebill_failed')
),
rebill_cycle AS (
  SELECT
    theme_slug,
    COUNT(*) FILTER (WHERE cycle = 1)                        AS r1_attempts,
    COUNT(*) FILTER (WHERE cycle = 1 AND tx_type = 'rebill') AS r1_ok,
    COUNT(*) FILTER (WHERE cycle = 2)                        AS r2_attempts,
    COUNT(*) FILTER (WHERE cycle = 2 AND tx_type = 'rebill') AS r2_ok,
    COUNT(*) FILTER (WHERE cycle = 3)                        AS r3_attempts,
    COUNT(*) FILTER (WHERE cycle = 3 AND tx_type = 'rebill') AS r3_ok
  FROM rebill_ranked
  GROUP BY theme_slug
),
ads AS (
  SELECT
    th."slug"                             AS theme_slug,
    COUNT(*)                              AS ad_clicks,
    COUNT(*) FILTER (WHERE g."converted") AS ad_conversions
  FROM "gAdsConversion" g
  JOIN "Theme" th ON th."themeId" = g."themeId"
  WHERE th."slug" IN (${slugList})
    AND g."createdAt" >= TIMESTAMP '${startLiteral}'${adsEnd}
  GROUP BY th."slug"
)
SELECT
  tx.theme_slug,
  COUNT(DISTINCT tx.application_id)                                       AS apps_acquired,
  COUNT(*) FILTER (WHERE tx_type = 'paid')                               AS first_paid,
  COUNT(*) FILTER (WHERE tx_type = 'failed')                             AS first_failed,
  ROUND(100.0 * COUNT(*) FILTER (WHERE tx_type = 'paid')
    / NULLIF(COUNT(*) FILTER (WHERE tx_type IN ('paid','failed')), 0), 1) AS auth_rate,
  COUNT(*) FILTER (WHERE tx_type = 'rebill')                             AS rebill_ok,
  COUNT(*) FILTER (WHERE tx_type = 'rebill_failed')                      AS rebill_fail,
  ROUND(100.0 * COUNT(*) FILTER (WHERE tx_type = 'rebill')
    / NULLIF(COUNT(*) FILTER (WHERE tx_type IN ('rebill','rebill_failed')), 0), 1) AS rebill_rate,
  COALESCE(MAX(rc.r1_attempts), 0)                                       AS r1_attempts,
  COALESCE(MAX(rc.r1_ok), 0)                                             AS r1_ok,
  ROUND(100.0 * MAX(rc.r1_ok) / NULLIF(MAX(rc.r1_attempts), 0), 1)       AS r1_rate,
  COALESCE(MAX(rc.r2_attempts), 0)                                       AS r2_attempts,
  COALESCE(MAX(rc.r2_ok), 0)                                             AS r2_ok,
  ROUND(100.0 * MAX(rc.r2_ok) / NULLIF(MAX(rc.r2_attempts), 0), 1)       AS r2_rate,
  COALESCE(MAX(rc.r3_attempts), 0)                                       AS r3_attempts,
  COALESCE(MAX(rc.r3_ok), 0)                                             AS r3_ok,
  ROUND(100.0 * MAX(rc.r3_ok) / NULLIF(MAX(rc.r3_attempts), 0), 1)       AS r3_rate,
  ROUND(COALESCE(SUM(amount_gbp) FILTER (WHERE tx_type IN ('paid','rebill')), 0), 2)               AS revenue_gbp,
  ROUND(COALESCE(SUM(amount_gbp) FILTER (WHERE tx_type IN ('full_refund','partial_refund')), 0), 2) AS refunds_gbp,
  ROUND(COALESCE(SUM(amount_gbp) FILTER (WHERE tx_type IN ('open_chargeback','resolved_chargeback')), 0), 2) AS chargebacks_gbp,
  ROUND(
      COALESCE(SUM(amount_gbp) FILTER (WHERE tx_type IN ('paid','rebill')), 0)
    - COALESCE(SUM(amount_gbp) FILTER (WHERE tx_type IN ('full_refund','partial_refund')), 0)
    - COALESCE(SUM(amount_gbp) FILTER (WHERE tx_type IN ('open_chargeback','resolved_chargeback')), 0)
  , 2)                                                                   AS net_revenue_gbp,
  ROUND(COALESCE(SUM(amount_gbp) FILTER (WHERE tx_type IN ('paid','rebill')), 0)
    / NULLIF(COUNT(DISTINCT tx.application_id), 0), 2)                   AS rev_per_acquired,
  ROUND(
    ( COALESCE(SUM(amount_gbp) FILTER (WHERE tx_type IN ('paid','rebill')), 0)
    - COALESCE(SUM(amount_gbp) FILTER (WHERE tx_type IN ('full_refund','partial_refund')), 0)
    - COALESCE(SUM(amount_gbp) FILTER (WHERE tx_type IN ('open_chargeback','resolved_chargeback')), 0) )
    / NULLIF(COUNT(DISTINCT tx.application_id), 0)
  , 2)                                                                   AS break_even_cac_gbp,
  ROUND(COALESCE(SUM(amount_native) FILTER (WHERE tx_type IN ('paid','rebill')), 0), 2)            AS revenue_native,
  ROUND(COALESCE(SUM(amount_native) FILTER (WHERE tx_type IN ('paid','rebill')), 0)
    / NULLIF(COUNT(DISTINCT tx.application_id), 0), 2)                   AS rev_per_acquired_native,
  MODE() WITHIN GROUP (ORDER BY ccy)                                     AS currency,
  COALESCE(MAX(ads.ad_clicks), 0)                                        AS ad_clicks,
  COALESCE(MAX(ads.ad_conversions), 0)                                   AS ad_conversions
FROM tx
LEFT JOIN ads ON ads.theme_slug = tx.theme_slug
LEFT JOIN rebill_cycle rc ON rc.theme_slug = tx.theme_slug
GROUP BY tx.theme_slug
ORDER BY tx.theme_slug;`.trim();
}

// ---------------------------------------------------------------------------
// Metabase HTTP helpers
// ---------------------------------------------------------------------------

interface MetabaseDatabase {
  id: number;
  name: string;
}

/** Metabase /api/database returns either a bare array or { data: [...] }. */
interface DatabaseListResponse {
  data?: MetabaseDatabase[];
}

/** Metabase /api/dataset native-query response (the bits we use). */
interface DatasetResponse {
  data?: {
    rows?: unknown[][];
    cols?: Array<{ name: string }>;
  };
  error?: string;
}

function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// The "MAIN DB - Production" id is stable for the life of the process, but every
// results query used to re-fetch the whole database list to find it — an extra
// Metabase round-trip before each query (and the home page fires one query per
// active experiment). Resolve it once per base URL and reuse the promise.
// Failures are not cached, so a transient error doesn't poison later queries.
const dbIdCache = new Map<string, Promise<number>>();

/** Resolve the "MAIN DB - Production" database id (memoised), or throw. */
function resolveDatabaseId(baseUrl: string, apiKey: string): Promise<number> {
  const cached = dbIdCache.get(baseUrl);
  if (cached) return cached;
  const p = fetchDatabaseId(baseUrl, apiKey);
  dbIdCache.set(baseUrl, p);
  p.catch(() => dbIdCache.delete(baseUrl));
  return p;
}

/** The uncached fetch — the whole /api/database list, filtered by name. */
async function fetchDatabaseId(baseUrl: string, apiKey: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/database`, {
    headers: { "x-api-key": apiKey, accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Metabase /api/database returned ${res.status}`);
  }
  const body = (await res.json()) as MetabaseDatabase[] | DatabaseListResponse;
  const list: MetabaseDatabase[] = Array.isArray(body) ? body : (body.data ?? []);
  const db = list.find((d) => d.name === MAIN_DB_NAME);
  if (!db) {
    throw new Error(
      `Database "${MAIN_DB_NAME}" not found in Metabase (saw: ${list.map((d) => d.name).join(", ") || "none"})`,
    );
  }
  return db.id;
}

/** Run a native SELECT via /api/dataset and return rows keyed by column name. */
async function runNativeQuery(
  baseUrl: string,
  apiKey: string,
  databaseId: number,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${baseUrl}/api/dataset`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    cache: "no-store",
    body: JSON.stringify({
      database: databaseId,
      type: "native",
      native: { query: sql },
    }),
  });
  if (!res.ok) {
    throw new Error(`Metabase /api/dataset returned ${res.status}`);
  }
  const body = (await res.json()) as DatasetResponse;
  if (body.error) {
    throw new Error(`Metabase query error: ${body.error}`);
  }
  const cols = body.data?.cols ?? [];
  const rows = body.data?.rows ?? [];
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      obj[c.name] = row[i];
    });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Map raw DB rows → typed VariantRow[] in the experiment's configured order
// ---------------------------------------------------------------------------

function toVariantRows(
  raw: Array<Record<string, unknown>>,
  experiment: RegisteredExperiment,
): VariantRow[] {
  const bySlug = new Map<string, Record<string, unknown>>();
  for (const r of raw) bySlug.set(String(r["theme_slug"]), r);

  const rows: VariantRow[] = [];
  for (const { variant, themeSlug } of experiment.resultsThemeMap) {
    const r = bySlug.get(themeSlug);
    // An arm with no cohort rows (e.g. a never-trafficked slug) is skipped
    // rather than fabricated — buildVerdict still works as long as control
    // is present.
    if (!r) continue;
    rows.push({
      variant,
      themeSlug,
      isControl: variant === experiment.controlVariant,
      appsAcquired: num(r["apps_acquired"]),
      firstPaid: num(r["first_paid"]),
      firstFailed: num(r["first_failed"]),
      authRate: num(r["auth_rate"]),
      rebillOk: num(r["rebill_ok"]),
      rebillFail: num(r["rebill_fail"]),
      rebillRate: num(r["rebill_rate"]),
      revenueGbp: num(r["revenue_gbp"]),
      revPerAcquired: num(r["rev_per_acquired"]),
      adClicks: num(r["ad_clicks"]),
      adConversions: num(r["ad_conversions"]),
      refundsGbp: num(r["refunds_gbp"]),
      chargebacksGbp: num(r["chargebacks_gbp"]),
      netRevenueGbp: num(r["net_revenue_gbp"]),
      breakEvenCacGbp: num(r["break_even_cac_gbp"]),
      revenueNative: num(r["revenue_native"]),
      revPerAcquiredNative: num(r["rev_per_acquired_native"]),
      currency: r["currency"] != null ? String(r["currency"]) : undefined,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Shared runner — resolves the DB and runs the extended results SQL for an
// arbitrary set of slugs + window. Both public entry points below build on it.
// NEVER throws.
// ---------------------------------------------------------------------------

type RawOutcome =
  | { available: true; raw: Array<Record<string, unknown>> }
  | { available: false; reason: string };

async function runResultsRaw(
  slugs: readonly string[],
  start: string,
  end?: string,
): Promise<RawOutcome> {
  if (slugs.length === 0) {
    return { available: false, reason: "No theme slugs to query" };
  }
  if (!start) {
    return { available: false, reason: "No cohort start date to query from" };
  }

  // Build (and, inside resultsSql(), VALIDATE) the query text before checking
  // config or making any network call — a malformed slug/date is rejected the
  // same way regardless of whether Metabase is even configured, and never
  // gets as far as a live round-trip. See resultsSql's own header comment.
  let sql: string;
  try {
    sql = resultsSql(slugs, start, end);
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : "Invalid query input",
    };
  }

  const apiKey = process.env.METABASE_API_KEY;
  if (!apiKey) {
    return { available: false, reason: "METABASE_API_KEY not configured" };
  }
  const baseUrl = (process.env.METABASE_URL ?? "").replace(/\/$/, "");
  if (!baseUrl) {
    return { available: false, reason: "METABASE_URL not configured" };
  }

  try {
    const databaseId = await resolveDatabaseId(baseUrl, apiKey);
    const raw = await runNativeQuery(baseUrl, apiKey, databaseId, sql);
    return { available: true, raw };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown Metabase error";
    return { available: false, reason };
  }
}

// ---------------------------------------------------------------------------
// Generic SELECT runner — for callers that need their own SELECT (e.g. the home
// cockpit's transaction-date-keyed "collected today" / recent-payments queries,
// which the cohort-keyed resultsSql above can't express). Same plumbing, same
// graceful degradation: no key / no URL / any error → { available:false, reason }.
// NEVER throws. SELECT-only — the caller is responsible for keeping it read-only.
// ---------------------------------------------------------------------------

export type MetabaseSelectOutcome =
  | { available: true; rows: Array<Record<string, unknown>> }
  | { available: false; reason: string };

export async function runMetabaseSelect(sql: string): Promise<MetabaseSelectOutcome> {
  const apiKey = process.env.METABASE_API_KEY;
  if (!apiKey) {
    return { available: false, reason: "METABASE_API_KEY not configured" };
  }
  const baseUrl = (process.env.METABASE_URL ?? "").replace(/\/$/, "");
  if (!baseUrl) {
    return { available: false, reason: "METABASE_URL not configured" };
  }
  try {
    const databaseId = await resolveDatabaseId(baseUrl, apiKey);
    const rows = await runNativeQuery(baseUrl, apiKey, databaseId, sql);
    return { available: true, rows };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown Metabase error";
    return { available: false, reason };
  }
}

// ---------------------------------------------------------------------------
// Public entry point — live per-variant P&L for a registered experiment
// ---------------------------------------------------------------------------

/**
 * Run the per-variant P&L results query for an experiment against Metabase.
 *
 * Returns a discriminated `ResultsOutcome`:
 *   - { available: true, rows } on success.
 *   - { available: false, reason } when the key is missing OR any step fails.
 * NEVER throws — the caller can render a clean empty/error state either way.
 */
export async function runResults(
  experiment: RegisteredExperiment,
): Promise<ResultsOutcome> {
  const slugs = experiment.resultsThemeMap.map((v) => v.themeSlug);
  const outcome = await runResultsRaw(slugs, experiment.startDate);
  if (!outcome.available) return outcome;

  const rows = toVariantRows(outcome.raw, experiment);
  if (rows.length === 0) {
    return { available: false, reason: "No cohort data found for this experiment yet" };
  }
  if (!rows.some((r) => r.isControl)) {
    return { available: false, reason: "Control arm has no data in the cohort window" };
  }
  return { available: true, rows };
}

// ---------------------------------------------------------------------------
// Public entry point — raw per-slug payment metrics for the archive attach flow
// ----------------------------------------------------------------------------
// The archive endpoint maps global-api theme slugs onto imported (VWO) variants,
// so it needs the RAW per-slug counts — not the VariantRow shape — to sum across
// the several slugs a single archived variant may span and recompute the rates.
// ---------------------------------------------------------------------------

/** One theme slug's payment counts, as read straight from the results query. */
export interface SlugPaymentRow {
  themeSlug: string;
  /** Distinct applications acquired in the cohort window. */
  appsAcquired: number;
  /** First-payment successes ("type"='paid'). */
  firstPaid: number;
  /** First-payment failures ("type"='failed'). */
  firstFailed: number;
  /** Rebill attempts / successes at cycle 1 (first renewal). */
  r1Attempts: number;
  r1Ok: number;
  /** Rebill attempts / successes at cycle 2. */
  r2Attempts: number;
  r2Ok: number;
  /** Rebill attempts / successes at cycle 3. */
  r3Attempts: number;
  r3Ok: number;
  /** Net revenue (GBP) = paid+rebill − refunds − chargebacks. */
  netRevenueGbp: number;
}

export type PaymentMetricsOutcome =
  | { available: true; rows: SlugPaymentRow[] }
  | { available: false; reason: string };

/**
 * Run the extended results query for an arbitrary set of theme slugs over a
 * window and return the raw per-slug payment counts. Degrades gracefully — no
 * key, no data, or a query error all surface as { available: false, reason }.
 * NEVER throws.
 */
export async function runPaymentMetrics(
  slugs: readonly string[],
  start: string,
  end?: string,
): Promise<PaymentMetricsOutcome> {
  const outcome = await runResultsRaw(slugs, start, end);
  if (!outcome.available) return outcome;

  const rows: SlugPaymentRow[] = outcome.raw.map((r) => ({
    themeSlug: String(r["theme_slug"]),
    appsAcquired: num(r["apps_acquired"]),
    firstPaid: num(r["first_paid"]),
    firstFailed: num(r["first_failed"]),
    r1Attempts: num(r["r1_attempts"]),
    r1Ok: num(r["r1_ok"]),
    r2Attempts: num(r["r2_attempts"]),
    r2Ok: num(r["r2_ok"]),
    r3Attempts: num(r["r3_attempts"]),
    r3Ok: num(r["r3_ok"]),
    netRevenueGbp: num(r["net_revenue_gbp"]),
  }));
  return { available: true, rows };
}
