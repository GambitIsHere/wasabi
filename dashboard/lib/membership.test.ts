// ============================================================================
// membership.ts — behavioural tests for the pure role-defaulting rule.
// ----------------------------------------------------------------------------
// roleForNthMembership() is the pure half of determineRoleForNewMembership()
// (split out specifically for this) — the DB-backed CRUD functions in this
// file (getMembership, createMembership, listPendingMembersForOrg, …) are
// exercised via browser verification against the real local Postgres rather
// than mocked-DB unit tests, matching this codebase's existing testing
// convention (vitest.config.mts: pure-function unit tests; see
// lib/tenant-scoping.test.ts / lib/credentials-auth.test.ts for the same
// split applied elsewhere in this batch).
// ============================================================================
import { describe, expect, it } from "vitest";
import { roleForNthMembership } from "@/lib/membership";

describe("roleForNthMembership — requirement 4's role-defaulting rule", () => {
  it("the first ACTIVE member of an org (count 0) becomes owner", () => {
    expect(roleForNthMembership(0, true)).toBe("owner");
  });

  it("the second member defaults to viewer", () => {
    expect(roleForNthMembership(1, true)).toBe("viewer");
  });

  it("every subsequent member also defaults to viewer, not editor", () => {
    expect(roleForNthMembership(2, true)).toBe("viewer");
    expect(roleForNthMembership(10, true)).toBe("viewer");
    expect(roleForNthMembership(1000, true)).toBe("viewer");
  });
});

describe("roleForNthMembership — I13: a pending self-registration never bootstraps to owner", () => {
  it("a NON-active first member (count 0) gets viewer, NOT owner", () => {
    // The squatting fix: a pending registrant on a fresh org can't claim owner.
    expect(roleForNthMembership(0, false)).toBe("viewer");
  });

  it("a non-active later member also gets viewer", () => {
    expect(roleForNthMembership(3, false)).toBe("viewer");
  });

  it("only the (active AND first) combination yields owner", () => {
    expect(roleForNthMembership(0, true)).toBe("owner"); // active + first  → owner
    expect(roleForNthMembership(0, false)).toBe("viewer"); // pending + first → viewer
    expect(roleForNthMembership(1, true)).toBe("viewer"); // active + later  → viewer
    expect(roleForNthMembership(1, false)).toBe("viewer"); // pending + later → viewer
  });
});
