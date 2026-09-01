// ============================================================================
// roles.ts — behavioural tests for role ranking + the status/role guards.
// ============================================================================
import { describe, expect, it } from "vitest";
import { isMembershipRole, isUserStatus, roleAtLeast } from "@/lib/roles";

describe("roleAtLeast", () => {
  it("a role always satisfies itself as the minimum", () => {
    expect(roleAtLeast("owner", "owner")).toBe(true);
    expect(roleAtLeast("viewer", "viewer")).toBe(true);
  });

  it("a higher role satisfies a lower minimum", () => {
    expect(roleAtLeast("owner", "viewer")).toBe(true);
    expect(roleAtLeast("admin", "editor")).toBe(true);
  });

  it("a lower role does NOT satisfy a higher minimum", () => {
    expect(roleAtLeast("viewer", "owner")).toBe(false);
    expect(roleAtLeast("editor", "admin")).toBe(false);
  });

  it("is the exact gate app/admin/members/actions.ts uses for approval — admin and owner pass, editor/viewer don't", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "admin")).toBe(true);
    expect(roleAtLeast("editor", "admin")).toBe(false);
    expect(roleAtLeast("viewer", "admin")).toBe(false);
  });
});

describe("isMembershipRole", () => {
  it("accepts every known role", () => {
    for (const role of ["viewer", "editor", "admin", "owner"]) {
      expect(isMembershipRole(role)).toBe(true);
    }
  });

  it("rejects an unknown string", () => {
    expect(isMembershipRole("superadmin")).toBe(false);
    expect(isMembershipRole("")).toBe(false);
  });
});

describe("isUserStatus", () => {
  it("accepts every known status", () => {
    for (const status of ["pending", "active", "suspended"]) {
      expect(isUserStatus(status)).toBe(true);
    }
  });

  it("rejects an unknown string", () => {
    expect(isUserStatus("banned")).toBe(false);
  });
});
