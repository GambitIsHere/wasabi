// ============================================================================
// create-gp-603.ts — the GP-603 registration must be locked to its contract:
// the immutable key, the five exact arm values, an even 20% split, the control
// arm, the "conversions" goal, the split-URL theme convention, and the prod
// guards. If any of these drift the storefront &var= contract breaks silently.
// ----------------------------------------------------------------------------
// A static source scan, not an execution test (same convention as
// migrate-tenancy.test.ts / migrate-youtrack-ticket.test.ts): the script runs
// main() at import and is prod-gated behind CONFIRM_CREATE_GP_603, so its shape
// is read as TEXT here rather than executed. It never imports/runs the script.
// ============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "create-gp-603.ts"),
  "utf8",
);

describe("create-gp-603 experiment definition", () => {
  it("registers the immutable key gp-603", () => {
    expect(SCRIPT).toMatch(/key:\s*"gp-603"/);
  });

  it("targets the Top Up business", () => {
    expect(SCRIPT).toMatch(/business:\s*"Top Up"/);
  });

  it('uses the "conversions" goal metric (the PR #9 Conversions / adConversions goal)', () => {
    expect(SCRIPT).toMatch(/goalMetric:\s*"conversions"/);
  });

  it("stores the GP-603 YouTrack ticket", () => {
    expect(SCRIPT).toMatch(/youtrackTicket:\s*"GP-603"/);
  });

  it("creates it active (LIVE, so /api/decide assigns from the first visitor)", () => {
    expect(SCRIPT).toMatch(/active:\s*true/);
  });

  it("declares exactly the five contract arms: control, static, rotate, marquee, ticker", () => {
    for (const v of ["control", "static", "rotate", "marquee", "ticker"]) {
      expect(SCRIPT).toMatch(new RegExp(`key:\\s*"${v}"`));
    }
    // Exactly five variant rows.
    const variantRows = SCRIPT.match(/key:\s*"[a-z0-9_-]+",\s*rolloutPercentage:/g) ?? [];
    expect(variantRows).toHaveLength(5);
  });

  it("splits evenly 20% per arm (sums to 100)", () => {
    const splits = [...SCRIPT.matchAll(/rolloutPercentage:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(splits).toHaveLength(5);
    expect(splits.every((n) => n === 20)).toBe(true);
    expect(splits.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("marks exactly one control — the control arm", () => {
    const controls = [...SCRIPT.matchAll(/isControl:\s*true/g)];
    expect(controls).toHaveLength(1);
    // control is the arm carrying isControl: true.
    expect(SCRIPT).toMatch(/key:\s*"control",\s*rolloutPercentage:\s*20,\s*themeSlug:\s*"control",\s*isControl:\s*true/);
  });

  it("uses the split-URL theme convention — each arm's themeSlug IS its variant value, never an invented global-api theme", () => {
    for (const v of ["control", "static", "rotate", "marquee", "ticker"]) {
      expect(SCRIPT).toMatch(new RegExp(`key:\\s*"${v}",\\s*rolloutPercentage:\\s*20,\\s*themeSlug:\\s*"${v}"`));
    }
    // Guard against a real TU theme slug sneaking in as an arm mapping.
    expect(SCRIPT).not.toMatch(/themeSlug:\s*"tu_/);
  });
});

describe("create-gp-603 safety guards", () => {
  it("refuses to run against the local Postgres proxy (USE_LOCAL_PG)", () => {
    expect(SCRIPT).toMatch(/USE_LOCAL_PG\s*===\s*"1"/);
    expect(SCRIPT).toMatch(/process\.exit\(2\)/);
  });

  it("requires an explicit CONFIRM_CREATE_GP_603=1 before any write", () => {
    expect(SCRIPT).toMatch(/CONFIRM_CREATE_GP_603\s*!==\s*"1"/);
  });

  it("requires DATABASE_URL (or POSTGRES_URL)", () => {
    expect(SCRIPT).toMatch(/process\.env\.DATABASE_URL\s*\?\?\s*process\.env\.POSTGRES_URL/);
  });

  it("prints the DB host only, never the connection string", () => {
    expect(SCRIPT).toMatch(/function dbHost/);
    expect(SCRIPT).toMatch(/new URL\(u\)\.host/);
  });

  it("is idempotent — no-ops when the experiment already exists", () => {
    expect(SCRIPT).toMatch(/already exists .* no-op/);
    expect(SCRIPT).toMatch(/SELECT 1 AS one FROM experiment WHERE key =/);
  });

  it("validates against the app's own invariants before connecting", () => {
    expect(SCRIPT).toMatch(/validateInput\(GP_603, allowedGoalMetrics\)/);
    expect(SCRIPT).toMatch(/SEED_METRICS\.filter\(\(m\)\s*=>\s*m\.isGoal\)/);
  });
});
