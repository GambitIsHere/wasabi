// ============================================================================
// lib/tenant-scoping.test.ts — a static guard against the
// forgotten-WHERE-clause class of cross-tenant leak.
// ----------------------------------------------------------------------------
// WHAT THIS CHECKS: every `sql\`…\`` statement in a data module (any lib/*.ts
// file that imports the DB client, discovered dynamically below — see
// dataModuleFiles()) that touches a directly tenant-scoped table (experiment /
// archived_experiment / event / metric / roadmap_test — see lib/tenant.ts's
// header for why those five and not the other two) must also carry its
// tenant column (org_id or project_id) as text in that same statement.
//
// A statement that touches a CHILD table (variant / archived_variant — which
// inherit tenancy through a parent foreign key rather than carrying their own
// column, see lib/tenant.ts) is exempted at the table level rather than
// requiring a comment on every occurrence, but must still reference its
// parent's key column (experiment_key / archived_key) — catching the cheap,
// real bug of a bare `DELETE FROM variant` with no WHERE at all.
//
// A statement that genuinely can't carry either can be marked with a
// `TENANT-SCOPE-EXEMPT:` comment on one of the few lines directly above it
// (see lib/events.ts's pruneEvents for the one real use today).
//
// LIMITS (read before trusting this too much):
//   - Keyword matching, not a real SQL parser. It looks for FROM / UPDATE /
//     INTO / JOIN followed by a table name, and for the tenant column as a
//     PLAIN SUBSTRING of that one statement's text. It can't tell a correct
//     `AND project_id = ${projectId}` from a decoy `-- project_id` in a
//     comment, and it can't see across a helper function boundary (a query
//     built by string concatenation instead of one `sql\`…\`` literal would
//     be invisible to it).
//   - Scans lib/**/*.ts recursively (subdirectories included — e.g.
//     lib/engine/ — so a future data module nested one level down can't slip
//     past this guard the way a top-level-only scan would have let it). A route
//     handler or component that somehow ran raw SQL directly (nothing does
//     today — see the repo-wide grep this test's PR description cites) would
//     still not be caught.
//   - Proves a tenant column is PRESENT in the statement text, not that the
//     WHERE actually applies it correctly (e.g. an OR that defeats it) or
//     that the value bound to it is the right one. It catches the forgotten
//     filter, not a wrong filter.
// Despite the limits, this is cheap and already earned its keep once: it's
// exactly the shape of scan that caught lib/admin-reseed.ts's reseed wiping
// every tenant's experiments (found and fixed in the same change that added
// this test — see that file's header).
// ============================================================================
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Tables that must carry their own tenant column on every statement, and
 *  which column — mirrors the per-table decision documented in lib/tenant.ts
 *  and applied by scripts/migrate-tenancy.ts. */
const DIRECTLY_SCOPED_TABLES: Record<string, "org_id" | "project_id"> = {
  experiment: "project_id",
  archived_experiment: "project_id",
  event: "project_id",
  metric: "project_id",
  roadmap_test: "org_id",
};

/** Child tables that inherit tenancy through a parent FK instead of a column
 *  of their own (lib/tenant.ts explains why they're not denormalised). Exempt
 *  from the org_id/project_id requirement at the table level; still required
 *  to reference the parent key column, so a bare unscoped statement against
 *  one of these still fails the guard. */
const PARENT_KEY_COLUMN: Record<string, string> = {
  variant: "experiment_key",
  archived_variant: "archived_key",
};

/** Inline escape hatch for a statement that genuinely can't carry a tenant
 *  filter — place this comment on one of the few lines directly above the
 *  `sql\`…\`` call. Used today only by lib/events.ts's pruneEvents (retention
 *  hygiene is deliberately global, not per-tenant — see that function). */
const EXEMPT_MARKER = "TENANT-SCOPE-EXEMPT:";
/** How many lines above a statement to look for EXEMPT_MARKER. Generous on
 *  purpose — a multi-line reason comment shouldn't have to hug the call. */
const EXEMPT_LOOKBACK_LINES = 10;

/** Matches `sql\`…\`` template literals — this codebase's ONLY way of issuing
 *  SQL (see lib/db.ts). `[^\`]*` is safe here because none of these
 *  statements interpolate an expression that itself contains a backtick
 *  (verified by inspection; a future statement that did would need this
 *  regex revisited, not just this comment). */
const SQL_LITERAL_RE = /\bsql`([^`]*)`/gs;

/** A statement "touches" a table when it names it right after FROM / UPDATE /
 *  INTO / JOIN (DELETE FROM is covered by FROM). Deliberately simple keyword
 *  matching, not a real SQL parser — see the header comment for the tradeoff. */
function tablesTouchedBy(statement: string): string[] {
  const re = /\b(?:from|update|into|join)\s+([a-z_]+)\b/gi;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(statement))) found.add(m[1]!.toLowerCase());
  return [...found];
}

/** Data modules to scan: every lib/*.ts file that imports the DB client,
 *  other than lib/db.ts itself (which legitimately owns the unscoped DDL that
 *  CREATEs these tables) and this test file. Dynamic on purpose — a new data
 *  module (e.g. a future lib/foo.ts that talks to Postgres) is picked up
 *  automatically instead of needing this list maintained by hand; that's how
 *  lib/admin-reseed.ts was caught (see the header comment). */
function dataModuleFiles(): string[] {
  // Recursive: entries come back as paths relative to LIB_DIR (e.g.
  // "engine/handlers.ts"), so a data module nested in a subdirectory is scanned
  // too. The db-import match allows any relative depth (`./db`, `../db`, …) so a
  // subdirectory file that imports the client through `../db` is still detected.
  return readdirSync(LIB_DIR, { recursive: true })
    .filter((f): f is string => typeof f === "string")
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => f !== "db.ts")
    .filter((f) => /from ["'](?:\.\.?\/)+db["']/.test(readFileSync(path.join(LIB_DIR, f), "utf8")));
}

interface Violation {
  statement: string;
  reason: string;
}

function checkFile(file: string): Violation[] {
  const src = readFileSync(path.join(LIB_DIR, file), "utf8");
  const lines = src.split("\n");
  const violations: Violation[] = [];

  SQL_LITERAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SQL_LITERAL_RE.exec(src))) {
    const statement = m[1]!;
    const startLine = src.slice(0, m.index).split("\n").length; // 1-indexed
    const windowStart = Math.max(0, startLine - 1 - EXEMPT_LOOKBACK_LINES);
    const precedingWindow = lines.slice(windowStart, startLine - 1).join("\n");
    if (precedingWindow.includes(EXEMPT_MARKER)) continue;

    for (const table of tablesTouchedBy(statement)) {
      const requiredCol = DIRECTLY_SCOPED_TABLES[table];
      if (requiredCol) {
        if (!statement.includes(requiredCol)) {
          violations.push({
            statement: statement.trim().slice(0, 140),
            reason: `touches "${table}" without "${requiredCol}" (around line ${startLine})`,
          });
        }
        continue;
      }
      const parentCol = PARENT_KEY_COLUMN[table];
      if (parentCol && !statement.includes(parentCol)) {
        violations.push({
          statement: statement.trim().slice(0, 140),
          reason: `touches child table "${table}" without its parent key "${parentCol}" (around line ${startLine})`,
        });
      }
      // Any other table name (e.g. a CTE alias, or `information_schema`) is
      // ignored — not one of the seven tenancy-relevant tables.
    }
  }
  return violations;
}

describe("tenant scoping guard", () => {
  const files = dataModuleFiles();

  it("found the data modules it expects to scan", () => {
    // A canary: if this ever comes back empty (e.g. the `from "./db"` import
    // pattern changes), every check below silently passes vacuously — fail
    // loud instead so the guard can't go quietly blind.
    expect(files).toEqual(
      expect.arrayContaining([
        "store.ts",
        "archive.ts",
        "events.ts",
        "roadmap-store.ts",
        "metrics.ts",
        "admin-reseed.ts",
      ]),
    );
  });

  for (const file of dataModuleFiles()) {
    it(`${file} — every scoped-table statement carries its tenant filter`, () => {
      expect(checkFile(file)).toEqual([]);
    });
  }
});
