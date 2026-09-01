// ============================================================================
// Wasabi — experiment metric trend (server-only).
// ----------------------------------------------------------------------------
// The home table's Trend column needs a day-over-day series, which nothing else
// stores (verdicts are computed point-in-time from Metabase). This appends a
// daily snapshot of each experiment's headline metric (challenger £/acquired) on
// each home render and reads the series back for the sparkline. So history
// builds forward: the column is empty on day one and fills in as days accrue —
// honest, not backfilled.
//
// Self-contained on purpose: it owns its own table via ensureReady() rather than
// adding to lib/db.ts's schema, so it doesn't collide with the multi-tenant work
// churning that file. The key (experiment_key) is globally unique, so no tenant
// scoping is needed here; a future batch can add project_id if snapshots ever
// need per-project isolation.
//
// SERVER-ONLY: imports lib/db.ts. Never import from a client component.
// Best-effort throughout — every failure is swallowed so the home page still
// renders (the sparkline just falls back to "—").
// ============================================================================
import { getSql } from "./db";

let ready: Promise<void> | null = null;

function ensureReady(): Promise<void> {
  return (ready ??= init());
}

async function init(): Promise<void> {
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS experiment_trend (
      experiment_key TEXT NOT NULL,
      day            TEXT NOT NULL,
      metric_key     TEXT NOT NULL,
      value          REAL NOT NULL,
      PRIMARY KEY (experiment_key, day, metric_key)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS experiment_trend_idx ON experiment_trend (metric_key, day)`;
}

/** UTC calendar day, YYYY-MM-DD — so one snapshot per experiment per day. */
function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface TrendEntry {
  key: string;
  metricKey: string;
  value: number;
}

/**
 * Upsert today's snapshot for each entry — the latest render of the day wins, so
 * a day resolves to that day's final metric value. One round-trip; never throws.
 */
export async function recordTrend(entries: TrendEntry[]): Promise<void> {
  const clean = entries.filter((e) => Number.isFinite(e.value));
  if (clean.length === 0) return;
  try {
    await ensureReady();
    const sql = getSql();
    const day = utcDay();
    await sql.transaction(
      clean.map(
        (e) => sql`
          INSERT INTO experiment_trend (experiment_key, day, metric_key, value)
          VALUES (${e.key}, ${day}, ${e.metricKey}, ${e.value})
          ON CONFLICT (experiment_key, day, metric_key)
          DO UPDATE SET value = EXCLUDED.value
        `,
      ),
    );
  } catch (err) {
    console.warn(
      "[wasabi] trend record failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The last `days` of a metric's series per experiment, oldest→newest. Returns a
 * plain object keyed by experiment_key (missing keys → absent → the table renders
 * "—"). Never throws — a read failure yields {}.
 */
export async function trendSeries(
  metricKey: string,
  days = 30,
): Promise<Record<string, number[]>> {
  try {
    await ensureReady();
    const sql = getSql();
    const cutoff = new Date(Date.now() - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const rows = (await sql`
      SELECT experiment_key, value
      FROM experiment_trend
      WHERE metric_key = ${metricKey} AND day >= ${cutoff}
      ORDER BY experiment_key ASC, day ASC
    `) as unknown as { experiment_key: string; value: number }[];
    const out: Record<string, number[]> = {};
    for (const r of rows) (out[r.experiment_key] ??= []).push(Number(r.value));
    return out;
  } catch (err) {
    console.warn(
      "[wasabi] trend read failed:",
      err instanceof Error ? err.message : err,
    );
    return {};
  }
}
