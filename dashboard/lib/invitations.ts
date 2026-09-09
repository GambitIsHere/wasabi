// ============================================================================
// Org invitations (server-only) — CRUD + accept logic over the `invitation`
// table (lib/db.ts's createSchema()).
// ----------------------------------------------------------------------------
// Self-registration (app/api/register/route.ts) and Google sign-in
// (auth.config.ts) both restrict WHO can join an org to people on that org's
// verified_domain (lib/domain-restriction.ts). That's correct for staff, but
// the product needs a second door: "add consultants and other QA non-staff
// members" — people who will never have an @org-domain address. An
// invitation is how an admin vouches for one specific external email.
//
// THE CENTRAL SECURITY PROPERTY: acceptInvitation() below bypasses the
// verified-domain check ENTIRELY, on purpose — see its own comment. Nothing
// in this file imports lib/domain-restriction.ts. The invite is the whole
// authorization model, bounded to the exact email + role an admin chose.
//
// Two redemption paths, with DIFFERENT strength — be precise about the
// guarantee each gives:
//   • SIGNED-IN redemption (acceptInvitation() here) ALSO requires the
//     accepting session's email to match the invited email exactly
//     (emailMatchesInvitation). A session proves control of that address, so on
//     THIS path a leaked link is useless to anyone but that address.
//   • NEW-USER redemption (acceptInviteAsNewUser in app/accept-invite/
//     actions.ts) is BEARER-authorized: holding a valid single-use invite is
//     itself sufficient to create an active, immediately-loggable account for
//     inv.email — the standard org-invite model, and the ONLY way an off-domain
//     invitee with no account can ever join. So on that path a leaked link is
//     as sensitive as the invite it carries: whoever holds it can claim the
//     account for the invited email — never any other email, never a higher
//     role than the admin chose, and only once. Treat invite links as secrets.
//     Gating activation behind a clicked email-verification link would close
//     this gap; it is a follow-up for when an email provider is wired up
//     (lib/email-verification.ts is a stub today).
//
// TESTABILITY SPLIT (mirrors lib/membership.ts's
// roleForNthMembership/determineRoleForNewMembership split — see that file's
// header): invitationStatus() and emailMatchesInvitation() are pure, I/O-free
// decision functions. Every security property this module test-covers
// (expiry, single-use, revoke-then-accept, the email-match gate, the domain
// bypass, role validation) reduces to one of these two functions plus
// isInvitationRole() — see lib/invitations.test.ts.
//
// TENANT SCOPING: every statement that reads/writes an org's invitations
// carries org_id (lib/tenant-scoping.test.ts's DIRECTLY_SCOPED_TABLES
// enforces this automatically — "invitation" is registered there). The one
// exception is getInvitationByToken: a raw invite token is a bearer secret,
// unique-indexed on its hash, and IS the identity being resolved — there is
// no org to filter by until AFTER this lookup succeeds, exactly like
// lib/users.ts's findUserByEmail resolving identity before any org is known.
// That statement carries an inline TENANT-SCOPE-EXEMPT marker for the guard.
// ============================================================================
import { createHash, randomBytes } from "node:crypto";
import { createSchema, getSql } from "./db";
import { findOrCreateMembership } from "./membership";
import type { MembershipRole } from "./roles";
import { normalizeEmail } from "./users";

// Defence-in-depth: never ship the DB layer to the browser.
if (typeof window !== "undefined") {
  throw new Error("lib/invitations.ts is server-only and must not run in the browser.");
}

// ---------------------------------------------------------------------------
// Roles an invite may grant. Deliberately NOT lib/roles.ts's full
// MembershipRole — "owner" is excluded everywhere below (parameter type,
// runtime validation, AND the DB column has no default that could produce
// it), because an invite must never be the way someone becomes an owner.
// ---------------------------------------------------------------------------
const INVITATION_ROLES = ["admin", "editor", "viewer"] as const;
export type InvitationRole = (typeof INVITATION_ROLES)[number];

export function isInvitationRole(value: string): value is InvitationRole {
  return (INVITATION_ROLES as readonly string[]).includes(value);
}

const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // mirrors app/api/register/route.ts's own check
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface Invitation {
  id: string;
  orgId: string;
  email: string;
  role: InvitationRole;
  tokenHash: string;
  /** First ~8 chars of the raw token — safe to display in a list (see
   *  api_key's key_prefix in lib/db.ts for the same pattern). */
  tokenPrefix: string;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

interface InvitationRow {
  id: string;
  org_id: string;
  email: string;
  role: string;
  token_hash: string;
  token_prefix: string;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    // Fail to the least-privileged invitable role rather than trust an
    // unrecognised column value as something more privileged — mirrors
    // lib/membership.ts's toMembership() and lib/users.ts's toUser().
    role: isInvitationRole(row.role) ? row.role : "viewer",
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
  };
}

// ---------------------------------------------------------------------------
// Token generation + hashing. The raw token is a 32-byte random value,
// base64url-encoded — it lives only in the invite link (returned once by
// createInvitation) and is never persisted; only its SHA-256 hash is stored,
// exactly like api_key's key_hash (lib/db.ts's header on that table).
// ---------------------------------------------------------------------------
function generateRawToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Exported so lib/invitations.test.ts can verify the hash/lookup round trip
 *  directly (deterministic, fixed-length hex) without going through the
 *  database. */
export function hashInvitationToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

// ---------------------------------------------------------------------------
// Pure decision logic — no I/O. See this file's header ("TESTABILITY SPLIT").
// ---------------------------------------------------------------------------

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

/**
 * Derive an invitation's current usability purely from its timestamp columns
 * + `now` (defaulted so callers never need to thread a clock through, but
 * tests can pin it). Checked in this order because an invite can technically
 * satisfy more than one condition at once (e.g. revoked AND expired) —
 * revoked wins (an admin's explicit revoke is authoritative regardless of
 * the clock), then accepted (single-use — already spent), then expiry.
 * "pending" is the ONLY status acceptInvitation() will proceed past.
 */
export function invitationStatus(
  inv: Pick<Invitation, "acceptedAt" | "revokedAt" | "expiresAt">,
  now: Date = new Date(),
): InvitationStatus {
  if (inv.revokedAt) return "revoked";
  if (inv.acceptedAt) return "accepted";
  if (new Date(inv.expiresAt).getTime() <= now.getTime()) return "expired";
  return "pending";
}

/**
 * The email-match gate — the ENTIRE anti-leaked-link protection (see this
 * file's header). Case-insensitive: `inv.email` is already stored lowercased
 * (createInvitation below), so this normalises only the candidate side.
 * Deliberately does not know or care about domains — see acceptInvitation's
 * comment on the bypass this enables.
 */
export function emailMatchesInvitation(inv: Pick<Invitation, "email">, candidateEmail: string): boolean {
  return inv.email === normalizeEmail(candidateEmail);
}

// ---------------------------------------------------------------------------
// DB-backed CRUD.
// ---------------------------------------------------------------------------

export interface CreateInvitationResult {
  /** The unhashed token — show this to the admin ONCE (as part of the invite
   *  link). Not recoverable after this call returns; only its hash is
   *  stored. */
  rawToken: string;
  invitation: Invitation;
}

/**
 * Create (or refresh) an invitation for `email` to join `orgId` at `role`.
 *
 * Validates its OWN inputs (role, email shape) rather than trusting the
 * caller — unlike lib/users.ts's createUser (which trusts
 * app/api/register/route.ts to have already validated), this is explicit
 * per the batch spec: "owner" must never be issuable no matter what a future
 * caller (Task B's form action, or anything else) passes in, so the guard
 * lives at the source, not at every call site.
 *
 * Dedup: if `(orgId, email)` already has a still-usable invite (pending —
 * not accepted, not revoked, not expired), that SAME row is refreshed in
 * place (new token, new 7-day expiry, latest role/inviter) rather than
 * inserting a second row. Chosen over "return the existing invite
 * unchanged" so a re-invite always hands out a link that's actually good
 * for a fresh 7 days; the old raw token (which nobody but the original
 * recipient ever saw) is silently invalidated by this UPDATE.
 * `created_at` is deliberately left untouched on a refresh — it's the row's
 * original-issue timestamp, not "last (re)sent".
 *
 * Race note: the existing-invite check and the insert/update below are two
 * separate round-trips (Neon's HTTP driver has no ambient transaction across
 * `sql` calls — see lib/membership.ts's determineRoleForNewMembership for
 * the same accepted trade-off elsewhere in this codebase). Two concurrent
 * invites for the same brand-new (org, email) could in the rare case both
 * insert instead of one refreshing the other — harmless (both are valid,
 * usable invitations; accepting either one succeeds and the other simply
 * goes unused), not a security issue. The refresh UPDATE is itself guarded
 * (`accepted_at IS NULL AND revoked_at IS NULL`, mirroring acceptInvitation's
 * own claim guard) against the narrower race where the existing invite gets
 * ACCEPTED in the gap between the SELECT above and this UPDATE — without the
 * guard, refreshing would silently rewrite token_hash/expires_at on a row
 * someone just legitimately used, handing them a dead link. When the guard
 * finds nothing left to refresh, this falls through to the INSERT below
 * instead of throwing — the caller still gets back one fresh, usable invite
 * either way.
 */
export async function createInvitation(
  orgId: string,
  email: string,
  role: string,
  invitedBy: string | null,
): Promise<CreateInvitationResult> {
  if (!isInvitationRole(role)) {
    throw new Error(`createInvitation: "${role}" is not an invitable role (owner can never be invited).`);
  }
  const normalizedEmail = normalizeEmail(email);
  if (!EMAIL_SHAPE_RE.test(normalizedEmail)) {
    throw new Error(`createInvitation: "${email}" is not a valid email address.`);
  }

  await createSchema();
  const sql = getSql();

  const rawToken = generateRawToken();
  const tokenHash = hashInvitationToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 8);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();

  const existingRows = (await sql`
    SELECT * FROM invitation
    WHERE org_id = ${orgId} AND email = ${normalizedEmail}
      AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
    LIMIT 1
  `) as unknown as InvitationRow[];
  const existing = existingRows[0];

  if (existing) {
    // Guarded refresh — see this function's header ("Race note"). Only
    // rewrites the row if it's STILL pending at write time; a concurrent
    // accept between the SELECT above and this UPDATE makes the WHERE match
    // nothing, and we fall through to the INSERT below instead of throwing.
    const refreshedRows = (await sql`
      UPDATE invitation
      SET role = ${role}, token_hash = ${tokenHash}, token_prefix = ${tokenPrefix},
          invited_by = ${invitedBy}, expires_at = ${expiresAt}
      WHERE id = ${existing.id} AND org_id = ${orgId} AND accepted_at IS NULL AND revoked_at IS NULL
      RETURNING *
    `) as unknown as InvitationRow[];
    const refreshedRow = refreshedRows[0];
    if (refreshedRow) {
      return { rawToken, invitation: toInvitation(refreshedRow) };
    }
    // else: raced — the invite we were about to refresh just got accepted
    // (or revoked). Fall through and insert a brand-new row instead.
  }

  const id = crypto.randomUUID();
  const rows = (await sql`
    INSERT INTO invitation (id, org_id, email, role, token_hash, token_prefix, invited_by, expires_at)
    VALUES (${id}, ${orgId}, ${normalizedEmail}, ${role}, ${tokenHash}, ${tokenPrefix}, ${invitedBy}, ${expiresAt})
    RETURNING *
  `) as unknown as InvitationRow[];
  const row = rows[0];
  if (!row) throw new Error("createInvitation: INSERT … RETURNING produced no row");
  return { rawToken, invitation: toInvitation(row) };
}

/**
 * Look up an invitation by its RAW (unhashed) token — hashes it and matches
 * on the unique token_hash index. Returns null for "no row with that hash",
 * indistinguishable here from "token is garbage" (both are just "not
 * found").
 *
 * TENANT-SCOPE-EXEMPT: lookup by bearer secret, not by tenant — see this
 * file's header ("TENANT SCOPING").
 */
export async function getInvitationByToken(rawToken: string): Promise<Invitation | null> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT * FROM invitation WHERE token_hash = ${hashInvitationToken(rawToken)}
  `) as unknown as InvitationRow[];
  const row = rows[0];
  return row ? toInvitation(row) : null;
}

export type AcceptInvitationResult =
  | { ok: true; orgId: string; role: MembershipRole }
  | { ok: false; reason: string };

/**
 * Redeem a raw invite token for `acceptingUser`. This is the
 * security-critical function in this module.
 *
 * Checks, in order:
 *   1. The token resolves to a real invitation at all.
 *   2. invitationStatus(inv) === "pending" — rejects an already-accepted
 *      (single-use), revoked, or expired invite. This is the ENTIRE
 *      single-use enforcement: once accepted_at is set, every later call
 *      with the same token fails here.
 *   3. emailMatchesInvitation(inv, acceptingUser.email) — the accepting
 *      session's email must be the exact address the admin invited. Stops a
 *      leaked link from granting access to a different account.
 *
 * 🔴 What this function deliberately does NOT check: the org's
 * verified_domain. Nothing here calls emailMatchesDomain or imports
 * lib/domain-restriction.ts. The invite (steps 1–3 above) IS the
 * authorization for this specific external email to join this specific
 * org — bypassing the domain restriction is the entire reason invitations
 * exist ("add consultants and other QA non-staff members" — see this file's
 * header). Every OTHER membership-granting path in this codebase
 * (auth.config.ts's Google signIn, app/api/register/route.ts) enforces that
 * restriction; this is the one deliberate exception.
 *
 * Membership creation goes through findOrCreateMembership (lib/membership.ts),
 * which is already idempotent — if `acceptingUser` somehow already has a
 * membership in `inv.orgId` (e.g. they accepted a second invite to the same
 * org, or were already added some other way), this is a no-op success rather
 * than an error or a role downgrade/upgrade surprise.
 *
 * Race note: THE CLAIM (the guarded UPDATE below) runs BEFORE membership is
 * granted, and everything after it is gated on that UPDATE having actually
 * matched a row (via `RETURNING id`). This is deliberately NOT
 * "findOrCreateMembership, then update" — that ordering let a concurrent
 * revoke land in the gap between the invitationStatus() read above and the
 * write, so membership got granted anyway even though accepted_at never
 * ended up set and the caller still saw ok:true (a write outcome and its
 * side effect disagreeing). With the claim first, a raced revoke — or a
 * raced second accept of the same token — makes the UPDATE match zero rows,
 * and this function returns ok:false WITHOUT ever calling
 * findOrCreateMembership. findOrCreateMembership is itself idempotent, so
 * the legitimate case of someone who already holds membership in
 * `inv.orgId` (e.g. from an earlier invite) accepting a second, still-valid
 * invite remains a safe no-op, not an error.
 */
export async function acceptInvitation(
  rawToken: string,
  acceptingUser: { id: string; email: string },
): Promise<AcceptInvitationResult> {
  const inv = await getInvitationByToken(rawToken);
  if (!inv) {
    return { ok: false, reason: "This invitation link is invalid." };
  }

  const status = invitationStatus(inv);
  if (status !== "pending") {
    // Distinguishing "expired" from "already accepted" from "revoked" isn't
    // a meaningful leak here (the caller already holds the link) and is
    // useful copy for Task B's accept page. This is a fast-path check on a
    // snapshot that can go stale by the time of the claim below — see this
    // function's header ("Race note").
    const reason =
      status === "accepted"
        ? "This invitation has already been used."
        : status === "revoked"
          ? "This invitation has been revoked."
          : "This invitation has expired.";
    return { ok: false, reason };
  }

  if (!emailMatchesInvitation(inv, acceptingUser.email)) {
    return { ok: false, reason: "This invitation was issued to a different email address." };
  }

  // THE CLAIM — the single atomic point that decides whether THIS call gets
  // to accept, and runs BEFORE membership is granted (see this function's
  // header "Race note"). Only when it actually matches a row (RETURNING id)
  // do we proceed to findOrCreateMembership + ok:true.
  await createSchema();
  const sql = getSql();
  const claimedRows = (await sql`
    UPDATE invitation
    SET accepted_at = now()
    WHERE id = ${inv.id} AND org_id = ${inv.orgId} AND accepted_at IS NULL AND revoked_at IS NULL
    RETURNING id
  `) as unknown as { id: string }[];

  if (claimedRows.length === 0) {
    // Raced: revoked, or accepted by another concurrent call, in the gap
    // between the read above and this write. No membership is granted for a
    // call that didn't actually win the claim.
    return { ok: false, reason: "This invitation was just used or revoked — it's no longer available." };
  }

  // See this function's header — deliberately no domain check between the
  // email-match gate above and granting membership here.
  await findOrCreateMembership(acceptingUser.id, inv.orgId, inv.role);

  return { ok: true, orgId: inv.orgId, role: inv.role };
}

/**
 * Revoke an invitation. Scoped to `orgId` — an `id` that exists but belongs
 * to a DIFFERENT org matches zero rows and returns null, exactly as if the
 * id didn't exist at all. This is the tenant-safety property: an admin of
 * org A can never revoke (or even learn the existence of) an invite
 * belonging to org B, even if they somehow got hold of its id.
 * `revoked_at IS NULL` makes a repeat call return null too (nothing left to
 * revoke) rather than stomping the original revoke timestamp.
 */
export async function revokeInvitation(id: string, orgId: string): Promise<Invitation | null> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    UPDATE invitation
    SET revoked_at = now()
    WHERE id = ${id} AND org_id = ${orgId} AND revoked_at IS NULL
    RETURNING *
  `) as unknown as InvitationRow[];
  const row = rows[0];
  return row ? toInvitation(row) : null;
}

/** Every invitation for `orgId`, newest first — the members UI's (Task B)
 *  full list, including used/revoked/expired ones for an audit trail. */
export async function listInvitations(orgId: string): Promise<Invitation[]> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT * FROM invitation WHERE org_id = ${orgId} ORDER BY created_at DESC
  `) as unknown as InvitationRow[];
  return rows.map(toInvitation);
}

/**
 * Only the invitations still usable right now — the members UI's (Task B)
 * "pending invites" section. Filters in application code via
 * invitationStatus() rather than duplicating that definition as a second SQL
 * WHERE shape, so "what counts as pending" can never drift between this list
 * and acceptInvitation's own check.
 */
export async function listPendingInvitations(orgId: string): Promise<Invitation[]> {
  const all = await listInvitations(orgId);
  return all.filter((inv) => invitationStatus(inv) === "pending");
}
