// ============================================================================
// scripts/reseed.ts — CLI entrypoint for the live-DB reseed.
// ----------------------------------------------------------------------------
// Thin wrapper around lib/admin-reseed.applySeed() — the same logic the
// in-app /admin/reseed page calls. In production prefer the in-app page
// (it inherits Vercel's runtime DATABASE_URL); this script is for local /
// CI use where you have DATABASE_URL on hand.
//
// Run from `dashboard/`:
//   DATABASE_URL='postgres://…' npm run reseed
// Or directly:
//   DATABASE_URL='…' node --experimental-strip-types --no-warnings \
//     --import ./scripts/ts-resolve-hook-register.mjs scripts/reseed.ts
// ============================================================================
import { applySeed } from "../lib/admin-reseed.ts";

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!url || url.trim().length === 0) {
  console.error(
    "[reseed] DATABASE_URL (or POSTGRES_URL) must be set. Note: `vercel env pull`",
  );
  console.error(
    "[reseed] does NOT export Vercel-Neon integration vars — use the in-app",
  );
  console.error(
    "[reseed] /admin/reseed page instead, or copy the connection string from",
  );
  console.error("[reseed] the Neon Console.");
  process.exit(2);
}

async function main(): Promise<void> {
  console.log("[reseed] connecting to Neon…");
  const result = await applySeed();
  console.log(
    `[reseed] wiped ${result.before} experiments → inserted ${result.after} at ${result.ranAt}`,
  );
  for (const e of result.experiments) {
    console.log(`  ✓ ${e.key.padEnd(24)} ${e.active ? "active" : "paused"}`);
  }
  console.log("[reseed] done.");
}

main().catch((err) => {
  console.error("[reseed] failed:", err);
  process.exit(1);
});
