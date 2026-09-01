// ============================================================================
// Membership roles + user account status — shared types and pure helpers.
// ----------------------------------------------------------------------------
// Kept dependency-free (no db.ts import) so it can be imported from
// types/next-auth.d.ts (type-only — erased at compile time), auth.ts, server
// actions, and tests alike without dragging in the DB layer or risking a
// cycle. The actual persisted values live in the `membership.role` and
// `user.status` TEXT columns (lib/db.ts) — these types are the single place
// that enumerates the allowed values; every read/write funnels through them
// rather than a raw string.
// ============================================================================

/** Ordered LEAST → MOST privileged. Batch D-a only ever assigns "owner" (the
 *  first member of a brand-new org) or "viewer" (every subsequent
 *  domain-matched sign-in) — "admin" and "editor" exist in the schema now so
 *  Batch D-b's invite/role UI doesn't need a migration to introduce them. */
export const MEMBERSHIP_ROLES = ["viewer", "editor", "admin", "owner"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

const ROLE_RANK: Readonly<Record<MembershipRole, number>> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

/** True when `role` carries at least `minimum`'s privilege — e.g.
 *  `roleAtLeast(role, "admin")` is the exact gate for "may approve a pending
 *  teammate" (requirement 3(b): an org owner OR admin may approve). */
export function roleAtLeast(role: MembershipRole, minimum: MembershipRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function isMembershipRole(value: string): value is MembershipRole {
  return (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

/** `user.status`. "pending" cannot get an authorized session (auth.ts's
 *  Credentials `authorize()` rejects anything but "active") — see the
 *  registration flow in app/register-actions.ts. */
export const USER_STATUSES = ["pending", "active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export function isUserStatus(value: string): value is UserStatus {
  return (USER_STATUSES as readonly string[]).includes(value);
}
