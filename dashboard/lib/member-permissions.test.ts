// ============================================================================
// member-permissions.ts — truth table for the Settings privilege model.
// ----------------------------------------------------------------------------
// These guards are the anti-escalation boundary for member management: an admin
// must never touch an owner or a peer admin, and must never mint an admin/owner.
// Every case an attacker would probe is asserted here.
// ============================================================================
import { describe, expect, it } from "vitest";
import {
  assignableRolesFor,
  canAssignRole,
  canManageMember,
  roleRank,
} from "@/lib/member-permissions";

describe("roleRank", () => {
  it("orders viewer < editor < admin < owner", () => {
    expect(roleRank("viewer")).toBeLessThan(roleRank("editor"));
    expect(roleRank("editor")).toBeLessThan(roleRank("admin"));
    expect(roleRank("admin")).toBeLessThan(roleRank("owner"));
  });
});

describe("canManageMember", () => {
  it("an admin may manage members strictly below them", () => {
    expect(canManageMember("admin", "viewer")).toBe(true);
    expect(canManageMember("admin", "editor")).toBe(true);
  });

  it("an admin may NOT manage a peer admin or an owner (no lateral/upward action)", () => {
    expect(canManageMember("admin", "admin")).toBe(false);
    expect(canManageMember("admin", "owner")).toBe(false);
  });

  it("an owner may manage anyone, including other owners", () => {
    for (const target of ["viewer", "editor", "admin", "owner"] as const) {
      expect(canManageMember("owner", target)).toBe(true);
    }
  });

  it("an editor or viewer may manage no one", () => {
    for (const actor of ["editor", "viewer"] as const) {
      for (const target of ["viewer", "editor", "admin", "owner"] as const) {
        expect(canManageMember(actor, target)).toBe(false);
      }
    }
  });
});

describe("canAssignRole", () => {
  it("an admin may grant only roles below their own — never admin or owner", () => {
    expect(canAssignRole("admin", "viewer")).toBe(true);
    expect(canAssignRole("admin", "editor")).toBe(true);
    expect(canAssignRole("admin", "admin")).toBe(false);
    expect(canAssignRole("admin", "owner")).toBe(false);
  });

  it("an owner may grant any role, including owner", () => {
    for (const next of ["viewer", "editor", "admin", "owner"] as const) {
      expect(canAssignRole("owner", next)).toBe(true);
    }
  });
});

describe("assignableRolesFor", () => {
  it("an admin's options are viewer + editor, plus the member's current role if higher", () => {
    expect(assignableRolesFor("admin", "viewer")).toEqual(["viewer", "editor"]);
    // current role always remains a selectable option even when not assignable
    expect(assignableRolesFor("admin", "admin")).toContain("admin");
    expect(assignableRolesFor("admin", "admin")).not.toContain("owner");
  });

  it("an owner may assign the full ladder", () => {
    expect(assignableRolesFor("owner", "viewer")).toEqual([
      "viewer",
      "editor",
      "admin",
      "owner",
    ]);
  });
});
