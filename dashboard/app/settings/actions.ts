"use server";

// ============================================================================
// Settings member-management server actions — approve / change-role / remove.
// ----------------------------------------------------------------------------
// Every action re-authorizes from the DB via lib/authz.requireRole("admin")
// (never the JWT alone — see that file's header on why the live re-check
// matters for a demoted/suspended caller), then scopes the TARGET to the
// caller's OWN org by looking the membership up as (targetUserId, auth.orgId).
// A userId belonging to another org therefore comes back null and is rejected,
// exactly like app/admin/members/actions.ts's approvePendingUser — the button
// being visible is never the security boundary.
//
// PRIVILEGE MODEL (enforced here, server-side, on top of the "must be admin"
// gate):
//   - canManage: you may act on a member only when your role outranks theirs,
//     OR you are an owner (an owner may act on other owners). So an admin can
//     never touch an owner or a peer admin; only an owner manages owners/admins.
//   - canAssign: you may grant a role strictly below your own (an admin can set
//     viewer/editor but never admin/owner); an owner may grant any role. This is
//     what stops an admin minting another admin or promoting anyone to owner.
//   - last-owner guard: demoting or removing the org's only owner is refused, so
//     an org can never be stranded with no one able to grant roles again.
// Self-actions fall out of the same rules: an admin can't change or remove
// themselves (rank not strictly greater than their own), and an owner can only
// self-demote/self-remove while a second owner exists.
// ============================================================================
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/authz";
import { canAssignRole, canManageMember } from "@/lib/member-permissions";
import {
  countOwnersForOrg,
  deleteMembership,
  getMembership,
  updateMembershipRole,
} from "@/lib/membership";
import { isMembershipRole } from "@/lib/roles";
import { getUserById, setUserStatus } from "@/lib/users";

export type MemberActionResult = { ok: true } | { ok: false; error: string };

const SETTINGS_PATH = "/settings";

/** Approve a pending self-registration (pending → active). Any admin/owner of
 *  the target's own org may approve; approval never changes the role, so it
 *  needs no rank check beyond "you are an admin". Mirrors
 *  app/admin/members/actions.ts's approvePendingUser, revalidating /settings. */
export async function approveMemberAction(userId: string): Promise<MemberActionResult> {
  const auth = await requireRole("admin");
  if (!auth.ok) return { ok: false, error: auth.error };

  const membership = await getMembership(userId, auth.orgId);
  if (!membership) {
    return { ok: false, error: "That user isn't a member of your organization." };
  }

  const user = await getUserById(userId);
  if (!user) return { ok: false, error: "User not found." };
  if (user.status !== "pending") {
    return { ok: false, error: "That user isn't pending approval." };
  }

  await setUserStatus(userId, "active");
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}

/** Change a member's role within the caller's org. Range-checks the requested
 *  role, then applies canManage + canAssign + the last-owner guard before the
 *  write. */
export async function changeMemberRoleAction(
  userId: string,
  nextRole: string,
): Promise<MemberActionResult> {
  const auth = await requireRole("admin");
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!isMembershipRole(nextRole)) return { ok: false, error: "Unknown role." };

  const target = await getMembership(userId, auth.orgId);
  if (!target) {
    return { ok: false, error: "That user isn't a member of your organization." };
  }

  if (target.role === nextRole) return { ok: true }; // idempotent no-op

  if (!canManageMember(auth.role, target.role)) {
    return { ok: false, error: "You can't change this member's role." };
  }
  if (!canAssignRole(auth.role, nextRole)) {
    return { ok: false, error: "You can't assign that role." };
  }

  if (target.role === "owner" && nextRole !== "owner") {
    const owners = await countOwnersForOrg(auth.orgId);
    if (owners <= 1) {
      return { ok: false, error: "The organization must keep at least one owner." };
    }
  }

  const updated = await updateMembershipRole(userId, auth.orgId, nextRole);
  if (!updated) {
    return { ok: false, error: "That user isn't a member of your organization." };
  }

  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}

/** Remove a member from the caller's org (deletes the membership row only —
 *  see lib/membership.deleteMembership's header on the lazy-reprovision caveat
 *  and the suspend lever for a hard lockout). Guards owners the same way as a
 *  demotion. */
export async function removeMemberAction(userId: string): Promise<MemberActionResult> {
  const auth = await requireRole("admin");
  if (!auth.ok) return { ok: false, error: auth.error };

  const target = await getMembership(userId, auth.orgId);
  if (!target) {
    return { ok: false, error: "That user isn't a member of your organization." };
  }

  if (!canManageMember(auth.role, target.role)) {
    return { ok: false, error: "You can't remove this member." };
  }

  if (target.role === "owner") {
    const owners = await countOwnersForOrg(auth.orgId);
    if (owners <= 1) {
      return { ok: false, error: "The organization must keep at least one owner." };
    }
  }

  const removed = await deleteMembership(userId, auth.orgId);
  if (!removed) {
    return { ok: false, error: "That user isn't a member of your organization." };
  }

  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}
