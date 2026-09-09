// ============================================================================
// #27: the organization.verified_domain UNIQUE index must normalise its key the
// SAME way the app does before it compares domains, so a whitespace/@/case
// variant can't slip a duplicate past once an org-write path exists — and NULL
// (no verified domain) must stay exempt so many domain-less orgs can coexist.
// ----------------------------------------------------------------------------
// createSchema() issues raw Postgres DDL and `npm test` runs fully offline (no
// local Postgres — this codebase's convention: DB modules mock @/lib/db, DDL
// shape is asserted by a static source scan, exactly like
// scripts/migrate-tenancy.test.ts). So this file pins the DDL text of the index
// AND the app-side normalisation contract the index mirrors; the two together
// encode "two orgs can't share a domain case-insensitively / whitespace/@
// variants collapse / multiple NULLs allowed" without a live database.
// ============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeDomain } from "@/lib/domain-restriction";

const DB_SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "db.ts"),
  "utf8",
);

describe("#27 verified_domain unique index — DDL shape", () => {
  it("normalises the key like the app (trim + strip @ + lowercase), not lower() alone", () => {
    // lower(btrim(verified_domain, ' @')) mirrors lib/domain-restriction's
    // normalizeDomain; the first cut keyed on lower(verified_domain) alone.
    expect(DB_SRC).toMatch(/lower\(btrim\(verified_domain,\s*' @'\)\)/);
    expect(DB_SRC).not.toMatch(/ON organization \(lower\(verified_domain\)\)/);
  });

  it("is a UNIQUE index (one org per normalised domain)", () => {
    expect(DB_SRC).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS organization_verified_domain_norm_idx/,
    );
  });

  it("is PARTIAL on NOT NULL — multiple NULL-domain orgs are allowed", () => {
    // The WHERE clause is what lets many domain-less orgs coexist (NULL is never
    // equal to NULL, but a plain unique index over an expression would still
    // need the partial predicate to stay out of the way — it's asserted here so
    // it can't be dropped by accident).
    expect(DB_SRC).toMatch(
      /organization_verified_domain_norm_idx[\s\S]*?WHERE verified_domain IS NOT NULL/,
    );
  });

  it("DROPs the old lower()-only index so the tighter key takes effect on an already-migrated DB", () => {
    // CREATE ... IF NOT EXISTS on the original name would no-op on a DB that
    // already has the weaker index; the DROP is what makes the migration real.
    expect(DB_SRC).toMatch(/DROP INDEX IF EXISTS organization_verified_domain_idx/);
  });
});

describe("#27 app-side normalisation contract the index mirrors", () => {
  it("collapses case / surrounding whitespace / a leading @ to one key", () => {
    const canonical = normalizeDomain("sanjow.com");
    for (const variant of ["sanjow.com", " sanjow.com ", "@sanjow.com", "SANJOW.COM", " @Sanjow.Com "]) {
      expect(normalizeDomain(variant)).toBe(canonical);
    }
    // Two orgs whose stored domains differ only by these variants would produce
    // the SAME index key → the UNIQUE constraint rejects the second.
    expect(normalizeDomain("@SANJOW.COM")).toBe(normalizeDomain("sanjow.com"));
  });

  it("keeps genuinely different domains distinct", () => {
    expect(normalizeDomain("sanjow.com")).not.toBe(normalizeDomain("acme.com"));
  });
});
