// ============================================================================
// Wasabi — SQLite connection (server-only).
// ----------------------------------------------------------------------------
// A single, long-lived node:sqlite connection. Because Wasabi runs as a
// long-running self-hosted Node server (next dev / next start), a file-backed
// store persists across requests and restarts — exactly what we want.
//
// SERVER-ONLY: this module imports node:sqlite and node:fs. It must NEVER be
// pulled into a client bundle. We import it only from server code (lib/store.ts,
// invoked by server components and "use server" actions) and hard-guard against
// a browser environment below.
//
// ZERO npm deps: node:sqlite is built into Node (>= 22.5 experimental, stable in
// 24/25). If Turbopack ever refuses to bundle it, lib/store.ts is the only
// consumer and can swap to a JSON store without touching the rest of the app.
// ============================================================================
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// Defence-in-depth: if this somehow reaches a browser bundle, fail loudly rather
// than ship node:sqlite to the client.
if (typeof window !== "undefined") {
  throw new Error("lib/db.ts is server-only and must not run in the browser.");
}

/** Resolve the DB path: WASABI_DB env override, else <cwd>/.data/wasabi.db. */
function resolveDbPath(): string {
  const fromEnv = process.env.WASABI_DB;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return join(process.cwd(), ".data", "wasabi.db");
}

// Singleton — survive Next's dev hot-reload by stashing the handle on globalThis
// so we don't leak a new connection (and re-run schema) on every module reload.
const globalForDb = globalThis as unknown as { __wasabiDb?: DatabaseSync };

function openDatabase(): DatabaseSync {
  const dbPath = resolveDbPath();
  // Ensure the parent dir exists (.data/ is gitignored).
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  // Pragmas tuned for a single long-running server: WAL for concurrent reads,
  // foreign keys on so variant rows cascade with their experiment.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema(db);
  return db;
}

/** The shared connection. Lazily opened on first use, reused thereafter. */
export function getDb(): DatabaseSync {
  if (!globalForDb.__wasabiDb) {
    globalForDb.__wasabiDb = openDatabase();
  }
  return globalForDb.__wasabiDb;
}

/** Create the schema if it doesn't exist. Idempotent. */
function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiment (
      key         TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      business    TEXT NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      goal_metric TEXT NOT NULL,
      start_date  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS variant (
      experiment_key     TEXT NOT NULL,
      key                TEXT NOT NULL,
      rollout_percentage INTEGER NOT NULL,
      theme_slug         TEXT NOT NULL,
      is_control         INTEGER NOT NULL DEFAULT 0,
      position           INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (experiment_key, key),
      FOREIGN KEY (experiment_key) REFERENCES experiment(key) ON DELETE CASCADE
    );
  `);
}
