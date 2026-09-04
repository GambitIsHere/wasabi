// ============================================================================
// Org membership (server-only) — CRUD over the `membership` join table, plus
// the one piece of policy small enough not to deserve its own module: role
// defaulting for a brand-new member.
// ----------------------------------------------------------------------------
// Used by both sign-in paths — auth.ts's Google `signIn` callback and
// app/register-actions.ts's password registration — which is exactly why
// role-defaulting lives here instead of being duplicated in each: "first
// member of an org becomes owner, everyone after defaults to viewer"
// (requirement 4) must be the SAME rule regardless of how someone joined.
// ============================================================================
import { createSchema, getSql } from "./db";
import {
  isMembershipRole,
  isUserStatus,
  roleAtLeast,
  type MembershipRole,
  type UserStatus,
} from "./roles";
import type { User } from "./users";

// Defence-in-depth: never ship the DB layer to the browser.
if (typeof window !== "undefined") {
  throw new Error("lib/membership.ts is server-only and must not run in the browser.");
}

export interface Membership {
  userId: string;
  orgId: string;
  role: MembershipRole;
  createdAt: string;
}

interface MembershipRow {
  user_id: string;
  org_id: string;
  role: string;
  created_at: string;
}

function toMembership(row: MembershipRow): Membership {
  return {
    userId: row.user_id,
    orgId: row.org_id,
    role: isMembershipRole(row.role) ? row.role : "viewer", // fail to the LEAST privileged role, never silently trust an unrecognised value as elevated
    createdAt: row.created_at,
  };
}

export async function getMembership(userId: string, orgId: string): Promise<Membership | null> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT * FROM membership WHERE user_id = ${userId} AND org_id = ${orgId}
  `) as unknown as MembershipRow[];
  const row = rows[0];
  return row ? toMembership(row) : null;
}

/** Count of ACTIVE members in `orgId` — a "pending" self-registration is NOT
 *  counted (I13). Two reasons, both about the owner-bootstrap in
 *  roleForNthMembership below: a pending registrant must not COUNT as the org's
 *  first member (or it could claim owner), and it must not INFLATE the count
 *  either (or it would block a later legitimate active member from becoming the
 *  first owner, bricking the org). "pending" lives on `user`, so this JOINs. */
export async function countActiveMembers(orgId: string): Promise<number> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT COUNT(*)::int AS n
    FROM membership m
    JOIN "user" u ON u.id = m.user_id
    WHERE m.org_id = ${orgId} AND u.status = 'active'
  `) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

/**
 * Requirement 4's role-defaulting rule, hardened against org-bootstrap
 * squatting (I13). Split out from determineRoleForNewMembership() below so it's
 * unit-testable without a database (see lib/membership.test.ts).
 *
 * The org's first member becomes "owner" ONLY when that member is ACTIVE —
 * a self-registered "pending" user (app/api/register/route.ts) never
 * bootstraps itself to owner. Before this, the first member to touch a fresh
 * org was owner regardless of status, so anyone on the verified domain could
 * self-register first, claim owner, and brick the org (its only owner being an
 * unverified attacker; every later member defaulting to viewer). Now a pending
 * registrant defaults to "viewer" and waits for approval; an org is bootstrapped
 * to owner by its first ACTIVE member (Google SSO, whose identity Google has
 * already verified — auth.config.ts). `existingActiveMemberCount` excludes
 * pending users (countActiveMembers) so a pending registrant sitting in the org
 * can't block that. Every non-bootstrapping join defaults to "viewer" — the
 * least-privileged role; an owner/admin promotes via the role UI.
 */
export function roleForNthMembership(
  existingActiveMemberCount: number,
  joiningUserIsActive: boolean,
): MembershipRole {
  return joiningUserIsActive && existingActiveMemberCount === 0 ? "owner" : "viewer";
}

/**
 * DB-backed wrapper around roleForNthMembership(). `joiningUserIsActive` is the
 * status of the user being added — true for a Google sign-in (already verified
 * + active by the time auth.config.ts calls this) and for the lazy membership
 * provisioning in lib/authz.ts (which re-checks status === "active" first),
 * false for a "pending" self-registration. Callers MUST call this and
 * createMembership/findOrCreateMembership close together relative to other
 * sign-ins for the same org for the "first member" count to be meaningful —
 * there is no transaction wrapping the two (Neon's HTTP driver makes a
 * read-then-write transaction here more complexity than the actual risk
 * warrants: the race window is "two people complete their very first-ever
 * ACTIVE sign-in to a brand-new org within milliseconds of each other", and the
 * failure mode if it happens is "an org briefly has two owners" rather than
 * anything unsafe).
 */
export async function determineRoleForNewMembership(
  orgId: string,
  joiningUserIsActive: boolean,
): Promise<MembershipRole> {
  return roleForNthMembership(await countActiveMembers(orgId), joiningUserIsActive);
}

/**
 * Idempotent find-or-create: returns the existing membership if one already
 * exists for (userId, orgId), otherwise creates one with `roleIfCreating`.
 * Used by BOTH a repeat Google sign-in (membership already exists — must NOT
 * silently change an established member's role back to the default) and a
 * brand-new password registration (membership never existed yet).
 */
export async function findOrCreateMembership(
  userId: string,
  orgId: string,
  roleIfCreating: MembershipRole,
): Promise<Membership> {
  const existing = await getMembership(userId, orgId);
  if (existing) return existing;

  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    INSERT INTO membership (user_id, org_id, role)
    VALUES (${userId}, ${orgId}, ${roleIfCreating})
    ON CONFLICT (user_id, org_id) DO NOTHING
    RETURNING *
  `) as unknown as MembershipRow[];
  const row = rows[0];
  // A concurrent caller won the INSERT between our getMembership() read and
  // this INSERT (the race the header comment above accepts) — re-read rather
  // than treat "no row returned" as failure.
  if (row) return toMembership(row);
  const nowExisting = await getMembership(userId, orgId);
  if (!nowExisting) {
    throw new Error(`findOrCreateMembership: insert conflicted but no row exists for ${userId}/${orgId}`);
  }
  return nowExisting;
}

/** One pending member awaiting owner/admin approval — the admin approval
 *  page's (app/admin/members) row shape. Joins user (for identity + status)
 *  to membership (for role + which org) since "pending" lives on `user`, not
 *  `membership` — see lib/db.ts's header comment on the two tables. */
export interface PendingMember {
  userId: string;
  email: string;
  name: string | null;
  role: MembershipRole;
  registeredAt: string;
}

interface PendingMemberRow {
  user_id: string;
  email: string;
  name: string | null;
  role: string;
  created_at: string;
}

/** Every "pending" user with a membership in `orgId`, oldest registration
 *  first. Self-registration (app/register-actions.ts) always creates the
 *  membership row up front (even while the user is pending) specifically so
 *  this one JOIN is all the approval page needs — no separate "applications"
 *  table. */
export async function listPendingMembersForOrg(orgId: string): Promise<PendingMember[]> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT u.id AS user_id, u.email, u.name, m.role, u.created_at
    FROM "user" u
    JOIN membership m ON m.user_id = u.id
    WHERE m.org_id = ${orgId} AND u.status = 'pending'
    ORDER BY u.created_at ASC
  `) as unknown as PendingMemberRow[];
  return rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: isMembershipRole(row.role) ? row.role : "viewer",
    registeredAt: row.created_at,
  }));
}

/** True when `user` has at least `minimum` privilege within `orgId` — the
 *  gate for "may approve a pending teammate" (roleAtLeast(role, "admin")) and
 *  any future role-gated action. Returns false (never throws) for "no
 *  membership at all", so callers can use it directly as an authorization
 *  check without a separate null-check. */
export async function userHasRoleInOrg(
  user: Pick<User, "id">,
  orgId: string,
  minimum: MembershipRole,
): Promise<boolean> {
  const membership = await getMembership(user.id, orgId);
  if (!membership) return false;
  return roleAtLeast(membership.role, minimum);
}

/** One member of an org, joined with the identity + account status the
 *  Settings member directory renders. `status` lives on `user` (a "pending"
 *  self-registration awaiting approval), `role` + `joinedAt` on `membership`
 *  — see lib/db.ts's header comment on the two tables. */
export interface OrgMember {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  role: MembershipRole;
  status: UserStatus;
  joinedAt: string;
}

interface OrgMemberRow {
  user_id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: string;
  status: string;
  created_at: string;
}

/** Every member of `orgId` — active, pending and suspended alike — for the
 *  Settings member directory (app/settings). Oldest membership first; the
 *  page groups pending rows to the top for approval. Both unrecognised
 *  role/status values fail closed to the least-privileged interpretation
 *  ("viewer" / "suspended"), mirroring toMembership()/toUser(). */
export async function listMembersForOrg(orgId: string): Promise<OrgMember[]> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT u.id AS user_id, u.email, u.name, u.image, m.role, u.status, m.created_at
    FROM membership m
    JOIN "user" u ON u.id = m.user_id
    WHERE m.org_id = ${orgId}
    ORDER BY m.created_at ASC
  `) as unknown as OrgMemberRow[];
  return rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    name: row.name,
    image: row.image,
    role: isMembershipRole(row.role) ? row.role : "viewer",
    status: isUserStatus(row.status) ? row.status : "suspended",
    joinedAt: row.created_at,
  }));
}

/** Count of members holding the "owner" role in `orgId`, regardless of
 *  account status. The Settings role/remove actions read this before demoting
 *  or removing an owner so an org can never be left with zero owners (which
 *  would strand it — no one could ever grant a role again). */
export async function countOwnersForOrg(orgId: string): Promise<number> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM membership WHERE org_id = ${orgId} AND role = 'owner'
  `) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** Set a member's role. Returns the updated row, or null when no membership
 *  exists for (userId, orgId) — the caller (app/settings/actions.ts) has
 *  already authorized and range-checked the change; this is the plain write. */
export async function updateMembershipRole(
  userId: string,
  orgId: string,
  role: MembershipRole,
): Promise<Membership | null> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    UPDATE membership SET role = ${role}
    WHERE user_id = ${userId} AND org_id = ${orgId}
    RETURNING *
  `) as unknown as MembershipRow[];
  const row = rows[0];
  return row ? toMembership(row) : null;
}

/** Remove a member from an org — deletes the `membership` row only (the
 *  `user` account itself is untouched; a user can belong to more than one
 *  org). Returns true when a row was deleted, false when none matched.
 *
 *  Note the lazy-provisioning caveat in lib/authz.ts: a removed member whose
 *  email still matches the org's verified domain would be re-provisioned as a
 *  "viewer" on their next authorized action. Removal is therefore fully
 *  effective as a demotion (an admin/owner drops to nothing, then re-enters at
 *  viewer) and fully effective for a user off the verified domain; suspending
 *  the user account (lib/users.setUserStatus) is the lever for a hard lockout. */
export async function deleteMembership(userId: string, orgId: string): Promise<boolean> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    DELETE FROM membership WHERE user_id = ${userId} AND org_id = ${orgId} RETURNING user_id
  `) as unknown as { user_id: string }[];
  return rows.length > 0;
}
