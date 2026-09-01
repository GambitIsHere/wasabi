// ============================================================================
// migrate-tenancy.ts — I9: the tenancy migration must DROP the column default
// after backfilling, keeping NOT NULL. A lingering DEFAULT silently lands any
// forgotten-column INSERT in Sanjow's data (a wrong-tenant write with no error).
// ----------------------------------------------------------------------------
// This is a static source scan, not an execution test: the script runs main()
// at import and is hard-gated to local Postgres, so it's read as TEXT here (its
// DDL shape is what matters and is deterministic). It never imports/executes
// the script.
// ============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "migrate-tenancy.ts"),
  "utf8",
);

describe("migrate-tenancy DDL shape (I9)", () => {
  it("DROPs the column default after backfill", () => {
    expect(SCRIPT).toMatch(/ALTER COLUMN\s+\$\{sql\.unsafe\(column\)\}\s+DROP DEFAULT/);
  });

  it("no longer SETs a column default (the wrong-tenant-write trap)", () => {
    expect(SCRIPT).not.toMatch(/SET DEFAULT/);
  });

  it("still SETs NOT NULL (a forgotten column must fail loud, not silently default)", () => {
    expect(SCRIPT).toMatch(/ALTER COLUMN\s+\$\{sql\.unsafe\(column\)\}\s+SET NOT NULL/);
  });

  it("dropped the now-unused SET-DEFAULT string-literal helper", () => {
    // sqlStringLiteral only existed to quote the SET DEFAULT constant; it must be
    // gone so tsc/lint don't flag an unused function.
    expect(SCRIPT).not.toMatch(/sqlStringLiteral/);
  });
});
