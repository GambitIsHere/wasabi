// ============================================================================
// lib/platform.test.ts — the operator console's cross-org aggregation is pure
// row→domain mapping + count folding once the SQL returns; those pure pieces
// are unit-tested here without a database (the DB functions are thin wrappers
// over them, same split lib/store.ts / lib/verdict.ts use). Importing
// lib/platform.ts also exercises its server-only window guard is satisfied
// under the node test environment.
// ============================================================================
import { describe, expect, it } from "vitest";
import {
  composeOverview,
  toArchivedStatus,
  toOrgSummary,
  toPlatformExperiment,
  toPlatformMember,
} from "@/lib/platform";
import { experimentStatus } from "@/lib/platform-types";

describe("composeOverview — folds the grouped user-status rows into scalars", () => {
  it("sums each status, defaulting absent statuses to 0", () => {
    const overview = composeOverview({
      orgs: 3,
      projects: 5,
      members: 12,
      liveExperiments: 8,
      activeExperiments: 4,
      archivedExperiments: 20,
      events: 999,
      eventsToday: 17,
      userStatusRows: [
        { status: "active", n: 9 },
        { status: "pending", n: 2 },
        { status: "suspended", n: 1 },
      ],
    });
    expect(overview).toEqual({
      orgs: 3,
      projects: 5,
      members: 12,
      activeUsers: 9,
      pendingUsers: 2,
      suspendedUsers: 1,
      liveExperiments: 8,
      activeExperiments: 4,
      archivedExperiments: 20,
      events: 999,
      eventsToday: 17,
    });
  });

  it("ignores unrecognised status buckets and tolerates missing rows", () => {
    const overview = composeOverview({
      orgs: 1,
      projects: 1,
      members: 1,
      liveExperiments: 0,
      activeExperiments: 0,
      archivedExperiments: 0,
      events: 0,
      eventsToday: 0,
      userStatusRows: [
        { status: "active", n: 1 },
        { status: "weird", n: 5 },
      ],
    });
    expect(overview.activeUsers).toBe(1);
    expect(overview.pendingUsers).toBe(0);
    expect(overview.suspendedUsers).toBe(0);
  });
});

describe("toOrgSummary", () => {
  it("maps snake_case counts to camelCase numbers", () => {
    expect(
      toOrgSummary({
        id: "sanjow",
        name: "Sanjow Ventures",
        verified_domain: "sanjow.com",
        created_at: "2026-01-01T00:00:00Z",
        member_count: 4,
        project_count: 2,
        live_count: 6,
        archived_count: 11,
      }),
    ).toEqual({
      id: "sanjow",
      name: "Sanjow Ventures",
      verifiedDomain: "sanjow.com",
      createdAt: "2026-01-01T00:00:00Z",
      memberCount: 4,
      projectCount: 2,
      liveExperimentCount: 6,
      archivedExperimentCount: 11,
    });
  });
});

describe("toPlatformMember — coerces role + status to the safe value", () => {
  it("passes through a valid role/status", () => {
    expect(
      toPlatformMember({
        user_id: "u1",
        email: "a@sanjow.com",
        name: "Al",
        user_status: "active",
        role: "admin",
        org_id: "sanjow",
        org_name: "Sanjow",
        joined_at: "2026-02-02T00:00:00Z",
      }),
    ).toMatchObject({ role: "admin", userStatus: "active", orgId: "sanjow" });
  });

  it("falls back to viewer / suspended on an unrecognised value (never escalates)", () => {
    const m = toPlatformMember({
      user_id: "u2",
      email: "b@x.com",
      name: null,
      user_status: "???",
      role: "superuser",
      org_id: "acme",
      org_name: "Acme",
      joined_at: "2026-03-03T00:00:00Z",
    });
    expect(m.role).toBe("viewer");
    expect(m.userStatus).toBe("suspended");
  });
});

describe("toArchivedStatus", () => {
  it("accepts the four known statuses", () => {
    for (const s of ["winner", "inconclusive", "lost", "archived"] as const) {
      expect(toArchivedStatus(s)).toBe(s);
    }
  });
  it("returns null for null or an unknown string", () => {
    expect(toArchivedStatus(null)).toBeNull();
    expect(toArchivedStatus("bogus")).toBeNull();
  });
});

describe("toPlatformExperiment", () => {
  it("maps a live experiment: active from int 1, archivedStatus null", () => {
    const exp = toPlatformExperiment({
      kind: "live",
      key: "tu-cta",
      name: "TU CTA colour",
      business: "TU",
      goal_metric: "auth_rate",
      active: 1,
      archived_status: null,
      start_date: "2026-08-01",
      created_at: "2026-08-01T09:00:00Z",
      org_id: "sanjow",
      org_name: "Sanjow",
    });
    expect(exp).toMatchObject({ kind: "live", active: true, archivedStatus: null });
  });

  it("maps a paused live experiment (active int 0 → false)", () => {
    const exp = toPlatformExperiment({
      kind: "live",
      key: "pdf-hero",
      name: "PDF hero",
      business: "PDF",
      goal_metric: null,
      active: 0,
      archived_status: null,
      start_date: null,
      created_at: "2026-08-01T09:00:00Z",
      org_id: "sanjow",
      org_name: "Sanjow",
    });
    expect(exp.active).toBe(false);
  });

  it("maps an archived experiment: active null, status coerced", () => {
    const exp = toPlatformExperiment({
      kind: "archived",
      key: "vwo-123",
      name: "Old VWO test",
      business: "AC",
      goal_metric: "cr",
      active: null,
      archived_status: "winner",
      start_date: "2025-01-01",
      created_at: "2025-06-01T00:00:00Z",
      org_id: "sanjow",
      org_name: "Sanjow",
    });
    expect(exp).toMatchObject({ kind: "archived", active: null, archivedStatus: "winner" });
  });
});

describe("experimentStatus — badge label + tone (pure)", () => {
  it("live active → Active/good, paused → Paused/faint", () => {
    expect(experimentStatus({ kind: "live", active: true, archivedStatus: null })).toEqual({
      label: "Active",
      tone: "good",
    });
    expect(experimentStatus({ kind: "live", active: false, archivedStatus: null })).toEqual({
      label: "Paused",
      tone: "faint",
    });
  });

  it("archived verdicts map to their tone", () => {
    expect(experimentStatus({ kind: "archived", active: null, archivedStatus: "winner" }).tone).toBe("good");
    expect(experimentStatus({ kind: "archived", active: null, archivedStatus: "lost" }).tone).toBe("bad");
    expect(experimentStatus({ kind: "archived", active: null, archivedStatus: "inconclusive" }).tone).toBe("warn");
    expect(experimentStatus({ kind: "archived", active: null, archivedStatus: "archived" }).label).toBe("Archived");
    expect(experimentStatus({ kind: "archived", active: null, archivedStatus: null }).label).toBe("Archived");
  });
});
