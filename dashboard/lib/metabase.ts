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
// ---------------------------------------------------------------------------

function resultsSql(slugs: readonly string[], start: string): string {
  // slugs and start come from our own registry, never user input, but we still
  // keep this SELECT-only and quote the literals defensively.
  const slugList = slugs.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ");
  const startLiteral = start.replace(/'/g, "''");
  return `
WITH variant AS (
  SELECT
    th."slug"          AS theme_slug,
    a."applicationId"  AS application_id
  FROM "Application" a
  JOIN "Theme" th ON th."themeId" = a."themeId"
  WHERE th."slug" IN (${slugList})
    AND a."createdAt" >= TIMESTAMP '${startLiteral}'
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
ads AS (
  SELECT
    th."slug"                             AS theme_slug,
    COUNT(*)                              AS ad_clicks,
    COUNT(*) FILTER (WHERE g."converted") AS ad_conversions
  FROM "gAdsConversion" g
  JOIN "Theme" th ON th."themeId" = g."themeId"
  WHERE th."slug" IN (${slugList})
    AND g."createdAt" >= TIMESTAMP '${startLiteral}'
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

/** Resolve the "MAIN DB - Production" database id, or throw a clear error. */
async function resolveDatabaseId(baseUrl: string, apiKey: string): Promise<number> {
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
// Public entry point
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
    const slugs = experiment.resultsThemeMap.map((v) => v.themeSlug);
    const sql = resultsSql(slugs, experiment.startDate);
    const raw = await runNativeQuery(baseUrl, apiKey, databaseId, sql);
    const rows = toVariantRows(raw, experiment);

    if (rows.length === 0) {
      return { available: false, reason: "No cohort data found for this experiment yet" };
    }
    if (!rows.some((r) => r.isControl)) {
      return { available: false, reason: "Control arm has no data in the cohort window" };
    }
    return { available: true, rows };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown Metabase error";
    return { available: false, reason };
  }
}
