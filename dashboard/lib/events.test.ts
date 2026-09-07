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
import { foldWiringRows, startOfTodayIso, type WiringEventGroup } from "@/lib/events";

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

describe("foldWiringRows — aggregating grouped event counts into wiring health", () => {
  it("returns the empty shape for no rows", () => {
    expect(foldWiringRows([])).toEqual({
      assignmentsToday: 0,
      assignmentsTotal: 0,
      capturesToday: 0,
      capturesTotal: 0,
      byArm: {},
    });
  });

  it("splits assignment vs conversion into the right totals, overall and per arm", () => {
    const rows: WiringEventGroup[] = [
      { variant: "control", kind: "assignment", total: 100, today: 10 },
      { variant: "control", kind: "conversion", total: 8, today: 1 },
      { variant: "variant_19", kind: "assignment", total: 90, today: 12 },
      { variant: "variant_19", kind: "conversion", total: 15, today: 3 },
    ];
    const w = foldWiringRows(rows);
    expect(w.assignmentsTotal).toBe(190);
    expect(w.assignmentsToday).toBe(22);
    expect(w.capturesTotal).toBe(23);
    expect(w.capturesToday).toBe(4);
    expect(w.byArm.control).toEqual({
      assignmentsToday: 10,
      assignmentsTotal: 100,
      capturesToday: 1,
      capturesTotal: 8,
    });
    expect(w.byArm.variant_19).toEqual({
      assignmentsToday: 12,
      assignmentsTotal: 90,
      capturesToday: 3,
      capturesTotal: 15,
    });
  });

  it("counts a NULL-variant capture in the experiment totals but drops it from byArm", () => {
    const rows: WiringEventGroup[] = [
      { variant: "control", kind: "assignment", total: 5, today: 5 },
      { variant: null, kind: "conversion", total: 4, today: 2 },
    ];
    const w = foldWiringRows(rows);
    expect(w.capturesTotal).toBe(4);
    expect(w.capturesToday).toBe(2);
    expect(Object.keys(w.byArm)).toEqual(["control"]);
  });

  it("treats any non-'assignment' kind as a capture", () => {
    const rows: WiringEventGroup[] = [
      { variant: "a", kind: "conversion", total: 3, today: 3 },
      { variant: "a", kind: "purchase", total: 2, today: 1 },
    ];
    const w = foldWiringRows(rows);
    expect(w.assignmentsTotal).toBe(0);
    expect(w.capturesTotal).toBe(5);
    expect(w.byArm.a?.capturesTotal).toBe(5);
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
