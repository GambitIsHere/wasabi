// ============================================================================
// Member-management privilege model — pure, DB-free, single source of truth.
// ----------------------------------------------------------------------------
// The SAME functions gate what the Settings UI renders (app/settings/page.tsx,
// components/settings/MemberRow.tsx) AND what the server actions enforce
// (app/settings/actions.ts). Keeping them here — rather than duplicated in each
// — is what stops the render decision ("show a Remove button") and the
// authorization decision ("allow the removal") from ever drifting apart. Dep-
// free (only lib/roles.ts types) so it stays unit-testable without a database.
//
// lib/authz.requireRole("admin") already runs first at every call site; these
// functions ALSO encode that admin floor themselves (a non-admin manages no one
// and can assign nothing) so the model is safe even if a future caller forgets
// that gate — defense in depth. On top of the floor they answer the finer
// question of which member an admin may act on, and which role they may grant.
// See lib/member-permissions.test.ts for the full truth table.
// ============================================================================
import { MEMBERSHIP_ROLES, roleAtLeast, type MembershipRole } from "./roles";

/** 0 (viewer) … 3 (owner) — the same order as roleAtLeast's ranking. */
export function roleRank(role: MembershipRole): number {
  return MEMBERSHIP_ROLES.indexOf(role);
}

/** True when an `actor` may act on (change the role of / remove) a member who
 *  currently holds `target`. The actor must be an admin/owner at all (the floor)
 *  AND either strictly outrank the target, or be an owner (an owner may act on
 *  other owners — the last-owner guard is applied separately by the caller). An
 *  admin can therefore never touch a peer admin or an owner; a viewer/editor can
 *  touch no one. */
export function canManageMember(actor: MembershipRole, target: MembershipRole): boolean {
  if (!roleAtLeast(actor, "admin")) return false;
  return actor === "owner" || roleRank(actor) > roleRank(target);
}

/** True when an `actor` may grant `next`. Requires the admin floor, then allows
 *  a role strictly below the actor's own (an admin may grant viewer/editor but
 *  never admin/owner — no self- or peer-escalation, no minting of new admins);
 *  an owner may grant any role. */
export function canAssignRole(actor: MembershipRole, next: MembershipRole): boolean {
  if (!roleAtLeast(actor, "admin")) return false;
  return actor === "owner" || roleRank(next) < roleRank(actor);
}

/** The roles `actor` may set for a member currently holding `current` — every
 *  role they can assign, plus the member's current role so a <select> always has
 *  a valid selected option even when it isn't otherwise assignable. */
export function assignableRolesFor(
  actor: MembershipRole,
  current: MembershipRole,
): MembershipRole[] {
  return MEMBERSHIP_ROLES.filter((r) => canAssignRole(actor, r) || r === current);
}
