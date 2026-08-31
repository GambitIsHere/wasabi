// ============================================================================
// Wasabi — Postgres connection (server-only), via Neon's serverless driver.
// ----------------------------------------------------------------------------
// Wasabi now runs on serverless (Vercel), where there is NO persistent local
// filesystem — so the old on-disk node:sqlite store couldn't persist. We use Neon
// Postgres over HTTP instead: each query is a stateless HTTPS request (no socket
// to pool), which is exactly right for serverless functions.
//
// SERVER-ONLY: never import from a client component (guarded below).
//
// Connection: DATABASE_URL (Vercel's Neon integration injects this; falls back to
// POSTGRES_URL). lib/store.ts is the only consumer.
// ============================================================================
import { neon, neonConfig } from "@neondatabase/serverless";

// Defence-in-depth: never ship the DB layer to the browser.
if (typeof window !== "undefined") {
  throw new Error("lib/db.ts is server-only and must not run in the browser.");
}

function connectionString(): string {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url || url.trim().length === 0) {
    throw new Error(
      "DATABASE_URL (or POSTGRES_URL) is not set. Add a Postgres database in " +
        "Vercel (Storage tab) — it injects the env var — or set it locally to run the app.",
    );
  }
  return url;
}

// Memoised query client. neon() is cheap (no persistent connection), but we parse
// the connection string once. Lazy, so a missing env at import/build time doesn't
// crash the build — it surfaces a clear error on first query instead.
let client: ReturnType<typeof neon> | null = null;

/** The Neon SQL tagged-template client. Use as: `const sql = getSql(); await sql\`…\`;` */
export function getSql(): ReturnType<typeof neon> {
  if (client) return client;
  // Local dev only: point the Neon HTTP driver at a local Neon-protocol proxy
  // (docker) that fronts a Postgres container, so the whole app — including
  // sql.transaction([...]) — runs fully offline. Guarded by USE_LOCAL_PG; prod
  // is untouched and hits Neon cloud directly.
  if (process.env.USE_LOCAL_PG === "1") {
    neonConfig.fetchEndpoint =
      process.env.NEON_LOCAL_PROXY ?? "http://localhost:4444/sql";
  }
  return (client = neon(connectionString()));
}

// Schema creation is idempotent (CREATE TABLE IF NOT EXISTS) and memoised per
// process so concurrent cold requests share a single round-trip.
let schemaPromise: Promise<void> | null = null;

/** Create the schema if it doesn't exist. Idempotent + memoised. */
export function createSchema(): Promise<void> {
  return (schemaPromise ??= doCreateSchema());
}

async function doCreateSchema(): Promise<void> {
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS experiment (
      key         TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      business    TEXT NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      goal_metric TEXT NOT NULL,
      start_date  TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    )
  `;
  // Idempotent migration for existing DBs that pre-date the description column.
  await sql`ALTER TABLE experiment ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`;
  await sql`
    CREATE TABLE IF NOT EXISTS variant (
      experiment_key     TEXT NOT NULL REFERENCES experiment(key) ON DELETE CASCADE,
      key                TEXT NOT NULL,
      rollout_percentage INTEGER NOT NULL,
      theme_slug         TEXT NOT NULL,
      is_control         INTEGER NOT NULL DEFAULT 0,
      position           INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (experiment_key, key)
    )
  `;

  // Archive — past experiments imported from other platforms (VWO first). Unlike
  // the live `experiment` model, these carry their RESULTS as stored data (the
  // live model computes results from payments at runtime; a historical run on
  // another platform has no such feed). Keyed separately so archive never mixes
  // with the routing hot path (/decide never reads these).
  await sql`
    CREATE TABLE IF NOT EXISTS archived_experiment (
      key               TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      business          TEXT NOT NULL,
      source            TEXT NOT NULL DEFAULT 'vwo',
      source_id         TEXT,
      source_url        TEXT,
      type              TEXT,
      status            TEXT NOT NULL DEFAULT 'archived',
      goal_metric       TEXT,
      start_date        TEXT,
      end_date          TEXT,
      winner_variant    TEXT,
      visitors_total    INTEGER NOT NULL DEFAULT 0,
      conversions_total INTEGER NOT NULL DEFAULT 0,
      hypothesis        TEXT NOT NULL DEFAULT '',
      notes             TEXT NOT NULL DEFAULT '',
      insight           TEXT NOT NULL DEFAULT '',
      imported_at       TEXT NOT NULL
    )
  `;
  // Idempotent migration for archive tables that pre-date the insight column.
  await sql`ALTER TABLE archived_experiment ADD COLUMN IF NOT EXISTS insight TEXT NOT NULL DEFAULT ''`;
  await sql`
    CREATE TABLE IF NOT EXISTS archived_variant (
      archived_key    TEXT NOT NULL REFERENCES archived_experiment(key) ON DELETE CASCADE,
      key             TEXT NOT NULL,
      name            TEXT NOT NULL DEFAULT '',
      is_control      INTEGER NOT NULL DEFAULT 0,
      visitors        INTEGER NOT NULL DEFAULT 0,
      conversions     INTEGER NOT NULL DEFAULT 0,
      conversion_rate REAL NOT NULL DEFAULT 0,
      improvement     REAL,
      chance_to_beat  REAL,
      position        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (archived_key, key)
    )
  `;
  // Idempotent migrations for the live payment read (attached from global-api via
  // Metabase). All nullable — an archived variant carries these only once payment
  // metrics have been attached; a plain VWO import leaves them null.
  await sql`ALTER TABLE archived_variant ADD COLUMN IF NOT EXISTS auth_rate REAL`;
  await sql`ALTER TABLE archived_variant ADD COLUMN IF NOT EXISTS rebill_r1 REAL`;
  await sql`ALTER TABLE archived_variant ADD COLUMN IF NOT EXISTS rebill_r2 REAL`;
  await sql`ALTER TABLE archived_variant ADD COLUMN IF NOT EXISTS rebill_r3 REAL`;
  await sql`ALTER TABLE archived_variant ADD COLUMN IF NOT EXISTS net_rev_per_acquired REAL`;

  // Event log — the assignment side of the live cockpit feed. /api/capture is a
  // public, unauthenticated endpoint; before this table it discarded every event
  // (see the old handleCapture note), so assignment activity was unrecoverable.
  // Now each capture persists ONE row here. The payment side of the feed (auth /
  // rebill / declined + amounts) is NOT stored — it is read live from global-api
  // via Metabase (lib/metabase.ts), keyed by theme slug. So this table holds only
  // what Metabase cannot give us: who was assigned to which arm, and when.
  //
  // Bounded on purpose (see lib/events.ts `pruneEvents`): rows older than 7 days
  // are pruned, with a 10,000-row hard cap as a second guard, so an unauthenticated
  // firehose can never grow it without limit. `ts` is a UTC ISO-8601 string
  // (always `new Date().toISOString()`), so lexicographic ordering == chronological.
  await sql`
    CREATE TABLE IF NOT EXISTS event (
      id             BIGSERIAL PRIMARY KEY,
      ts             TEXT NOT NULL,
      distinct_id    TEXT NOT NULL,
      event          TEXT NOT NULL,
      experiment_key TEXT,
      variant        TEXT,
      business       TEXT,
      kind           TEXT NOT NULL
    )
  `;
  // Feed + today-window reads both order/filter by ts newest-first.
  await sql`CREATE INDEX IF NOT EXISTS event_ts_idx ON event (ts DESC)`;

  // Roadmap — the editable, DB-backed version of the curated test plan that used
  // to live only in lib/roadmap.ts. Each row is one test on one lane's runway;
  // the drag-and-drop UI writes lane / start_week / end_week / position here so a
  // re-plan sticks for everyone. Lane-level metadata (business / repo / site) is
  // fixed per lane and stays in code (lib/roadmap.ts LANE_META) — never stored.
  // Seeded from the static ROADMAP on an empty table (lib/roadmap-store.ts).
  await sql`
    CREATE TABLE IF NOT EXISTS roadmap_test (
      id         TEXT PRIMARY KEY,
      lane       TEXT NOT NULL,
      ticket     TEXT NOT NULL DEFAULT '',
      title      TEXT NOT NULL,
      surface    TEXT NOT NULL DEFAULT '',
      start_week INTEGER NOT NULL,
      end_week   INTEGER NOT NULL,
      status     TEXT NOT NULL,
      pilot      INTEGER NOT NULL DEFAULT 0,
      note       TEXT,
      rerun_of   TEXT,
      position   INTEGER NOT NULL DEFAULT 0
    )
  `;
  // Runway reads order within a lane by position then start_week.
  await sql`CREATE INDEX IF NOT EXISTS roadmap_test_lane_idx ON roadmap_test (lane, position, start_week)`;
}
