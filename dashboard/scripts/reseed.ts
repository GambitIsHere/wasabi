// ============================================================================
// scripts/reseed.ts — wipe + re-apply the SEED to the live Neon DB.
// ----------------------------------------------------------------------------
// Use case: the seed-on-empty guard in lib/store.ts means the SEED only fires
// on a fresh DB. When the canonical SEED (lib/seeds.ts) is updated and you
// want the change reflected in an already-populated DB, run this script.
//
// What it does:
//   1. Ensures the schema (idempotent — adds the `description` column if missing).
//   2. DELETEs all rows from `variant` then `experiment` (FK cascade also works,
//      but explicit is clearer).
//   3. Re-inserts every SEED entry, applying SEED_PAUSED's `active = 0` flag.
//
// SAFE: targets only the Wasabi experiment store. Will NOT touch any other
// table on the Neon database.
//
// Run from `dashboard/`:
//   DATABASE_URL='postgres://…' npm run reseed
// Or directly:
//   DATABASE_URL='…' node --experimental-strip-types --no-warnings \
//     --import ./scripts/ts-resolve-hook-register.mjs scripts/reseed.ts
// ============================================================================
import { neon } from "@neondatabase/serverless";
import { SEED, SEED_PAUSED } from "../lib/seeds.ts";

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!url || url.trim().length === 0) {
  console.error(
    "[reseed] DATABASE_URL (or POSTGRES_URL) must be set. Pull it from Vercel:",
  );
  console.error("  vercel env pull .env.local --environment=production");
  console.error(
    "  then re-run with the env loaded, or pass DATABASE_URL=... inline.",
  );
  process.exit(2);
}

const sql = neon(url);

async function main(): Promise<void> {
  console.log("[reseed] connecting to Neon…");

  // Schema (idempotent) — ensures the description column exists on older DBs.
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

  // Count what we're about to clobber, so the operator can see scale.
  const before = (await sql`SELECT COUNT(*)::int AS n FROM experiment`) as unknown as { n: number }[];
  console.log(`[reseed] wiping ${before[0]?.n ?? 0} existing experiments + their variants…`);
  await sql`DELETE FROM variant`;
  await sql`DELETE FROM experiment`;

  const now = new Date().toISOString();
  console.log(`[reseed] inserting ${SEED.length} experiments…`);

  for (const exp of SEED) {
    const key = exp.key;
    if (!key) {
      console.warn(`[reseed] skipping seed without key: ${exp.name}`);
      continue;
    }
    const active = SEED_PAUSED.has(key) ? 0 : 1;
    const description = (exp.description ?? "").trim();

    await sql`
      INSERT INTO experiment (key, name, business, active, goal_metric, start_date, created_at, description)
      VALUES (${key}, ${exp.name.trim()}, ${exp.business}, ${active}, ${exp.goalMetric}, ${exp.startDate}, ${now}, ${description})
    `;
    for (let i = 0; i < exp.variants.length; i++) {
      const v = exp.variants[i]!;
      await sql`
        INSERT INTO variant (experiment_key, key, rollout_percentage, theme_slug, is_control, position)
        VALUES (${key}, ${v.key}, ${v.rolloutPercentage}, ${v.themeSlug}, ${v.isControl ? 1 : 0}, ${i})
      `;
    }

    console.log(`  ✓ ${key.padEnd(24)} ${active ? "active" : "paused"}`);
  }

  const after = (await sql`SELECT COUNT(*)::int AS n FROM experiment`) as unknown as { n: number }[];
  console.log(`[reseed] done — DB now holds ${after[0]?.n ?? 0} experiments.`);
}

main().catch((err) => {
  console.error("[reseed] failed:", err);
  process.exit(1);
});
