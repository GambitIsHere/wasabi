// ============================================================================
// migrate-youtrack-ticket.ts — the youtrack_ticket migration must be additive,
// idempotent, and hard-gated to local Postgres.
// ----------------------------------------------------------------------------
// A static source scan, not an execution test (same convention as
// migrate-tenancy.test.ts): the script runs main() at import and is gated to
// local Postgres, so its DDL shape is read as TEXT here rather than executed.
// ============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "migrate-youtrack-ticket.ts"),
  "utf8",
);

describe("migrate-youtrack-ticket DDL shape", () => {
  it("adds the column idempotently (ADD COLUMN IF NOT EXISTS)", () => {
    expect(SCRIPT).toMatch(
      /ALTER TABLE experiment ADD COLUMN IF NOT EXISTS youtrack_ticket TEXT NULL/,
    );
  });

  it("keeps the column nullable — no NOT NULL, no DEFAULT (safe on a populated table)", () => {
    expect(SCRIPT).not.toMatch(/youtrack_ticket[^`]*NOT NULL/);
    expect(SCRIPT).not.toMatch(/youtrack_ticket[^`]*DEFAULT/);
  });

  it("is hard-gated to local Postgres via USE_LOCAL_PG", () => {
    expect(SCRIPT).toMatch(/USE_LOCAL_PG.*!==.*"1"/);
    expect(SCRIPT).toMatch(/process\.exit\(2\)/);
  });
});
