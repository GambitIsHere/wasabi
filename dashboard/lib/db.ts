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
import { neon } from "@neondatabase/serverless";

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
  return (client ??= neon(connectionString()));
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
      created_at  TEXT NOT NULL
    )
  `;
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
}
