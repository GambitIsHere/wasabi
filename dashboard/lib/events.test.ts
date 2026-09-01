// ============================================================================
// events.ts — startOfTodayIso (pure) + a static shape check on the
// per-project hard-cap fairness fix (M3).
// ----------------------------------------------------------------------------
// pruneEvents itself is DB-backed (a Postgres DELETE against a live, shared
// `event` table) — matching this codebase's existing convention for exactly
// this class of problem (see scripts/migrate-tenancy.test.ts's header: "a
// static source scan, not an execution test" for the same reason: the DDL/DML
// shape is deterministic and is what matters, and there's no DB-free way to
// prove a Postgres window-function's runtime behaviour without a live database).
// Its actual per-project fairness behaviour (tenant A's rows survive when
// tenant B floods) was verified by hand against local Postgres — see the
// fix's PR/task notes — not re-run here on every `npm test`.
// ============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startOfTodayIso } from "@/lib/events";

const SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "events.ts"),
  "utf8",
);

describe("startOfTodayIso", () => {
  it("returns midnight UTC of the current day as an ISO-8601 string", () => {
    expect(startOfTodayIso()).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  });

  it("matches today's own UTC date", () => {
    expect(startOfTodayIso().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe("pruneEvents — M3: the hard cap is enforced PER-PROJECT, not globally", () => {
  it("partitions the hard-cap DELETE by project_id, so one tenant's volume can't evict another's rows", () => {
    expect(SOURCE).toMatch(/ROW_NUMBER\(\)\s+OVER\s*\(\s*PARTITION BY project_id ORDER BY id DESC\s*\)/);
  });

  it("still enforces the numeric HARD_CAP, inside each project's own partition", () => {
    expect(SOURCE).toMatch(/WHERE rn > \$\{HARD_CAP\}/);
  });

  it("keeps the retention-window delete global — a uniform expiry, not a fairness concern", () => {
    expect(SOURCE).toMatch(/DELETE FROM event WHERE ts < \$\{cutoff\}/);
  });

  it("the hard-cap statement is the one keyed off project_id, not the retention one", () => {
    // Guards against someone "fixing" the wrong statement — the retention
    // DELETE's own text must NOT itself carry the partition.
    const retentionStatement = SOURCE.slice(
      SOURCE.indexOf("DELETE FROM event WHERE ts <"),
      SOURCE.indexOf("DELETE FROM event WHERE ts <") + 80,
    );
    expect(retentionStatement).not.toMatch(/PARTITION BY/);
  });
});
