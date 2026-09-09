"use server";

// ============================================================================
// acceptInviteAction — the thin server-action entrypoint an accept-invite
// PAGE calls (Task B builds that page; this ships only the backend call it
// needs, per the batch spec).
// ----------------------------------------------------------------------------
// Deliberately thin: reads the current session, resolves it to a real `user`
// row, and hands off to lib/invitations.ts's acceptInvitation() for every
// actual security decision (status, email match, the domain bypass — see
// that module's header). Nothing here re-implements or duplicates any of
// that logic.
//
// SIGNED-OUT CALLER: returns a typed "sign in first" result rather than
// redirecting or rendering anything — building the sign-in UI/flow for an
// invitee who doesn't have a session yet (which, for an off-domain
// consultant, may mean they can't reach a session via the existing
// domain-restricted sign-up paths at all) is explicitly Task B's problem,
// not this entrypoint's.
//
// Why re-derive the user from the DB instead of trusting the session
// directly: Session.user isn't type-augmented with an `id` in this codebase
// (see types/next-auth.d.ts — only `orgId`/`role` were added), and even if it
// were, lib/authz.ts's requireRole() deliberately never trusts session
// claims for anything security-sensitive — a JWT can outlive a suspension by
// up to 30 days (that file's header). Accepting an invite grants real org
// access, so it gets the same live re-check: findUserByEmail + an explicit
// status === "active" check, exactly like requireRole does.
// ============================================================================
import { auth } from "@/auth";
import {
  acceptInvitation,
  getInvitationByToken,
  invitationStatus,
  type InvitationStatus,
} from "@/lib/invitations";
import { hashPassword, validatePasswordStrength } from "@/lib/password";
import type { MembershipRole } from "@/lib/roles";
import { createUser, deleteUser, findUserByEmail, isUniqueViolation, normalizeEmail, setUserStatus, type User } from "@/lib/users";

export type AcceptInviteActionResult =
  | { ok: true; orgId: string; role: MembershipRole }
  | { ok: false; reason: string };

export async function acceptInviteAction(token: string): Promise<AcceptInviteActionResult> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return { ok: false, reason: "You need to sign in before you can accept this invitation." };
  }

  const dbUser = await findUserByEmail(email);
  // Live status re-check (mirrors requireRole — see this file's header):
  // a suspended, or no-longer-active, account must not be able to redeem an
  // invite just because its old session JWT hasn't expired yet.
  if (!dbUser || dbUser.status !== "active") {
    return { ok: false, reason: "You need to sign in before you can accept this invitation." };
  }

  return acceptInvitation(token, { id: dbUser.id, email: dbUser.email });
}

// ============================================================================
// acceptInviteAsNewUser — the CREATE-ACCOUNT-ON-ACCEPT path (Task C).
// ----------------------------------------------------------------------------
// The other door into an org, for an invitee who has NO account yet — the
// off-domain consultant/QA the invitation system exists for (see
// lib/invitations.ts's header). They hold a valid single-use invite for their
// address but can never self-register: app/api/register/route.ts is
// domain-restricted, and their email is off-domain by definition.
//
// 🔴 THE DELIBERATE DOMAIN BYPASS — mirrors acceptInvitation()'s own "what this
// deliberately does NOT check" rationale. This is the ONE place a brand-new
// account is created WITHOUT a verified-domain check, and it is safe for
// exactly the reason acceptInvitation() is: the invite IS the authorization.
// Concretely:
//   - The email is taken from the INVITE RECORD (inv.email), NEVER from the
//     form — the caller cannot create an account for any address other than
//     the one an admin already vouched for.
//   - The role/org come from the invite (via acceptInvitation), never the form.
//   - The token is validated (resolves + still "pending") BEFORE any write, and
//     single-use is enforced downstream by acceptInvitation's claim-before-grant.
//   - An email that ALREADY has an account is refused up front, and again via
//     the unique-violation fallback — this path never creates a duplicate and
//     never touches an existing account's password.
//
// The account is created ACTIVE (not "pending" like a self-registration):
// there is nothing left to approve — an admin already approved this exact
// person by inviting them. It then clears credentials-auth's login gate
// (lib/credentials-auth.ts) on its own — status === "active" AND a membership
// (granted by acceptInvitation below) — with no domain check on the login
// path, so the off-domain address signs in normally afterwards.
// ============================================================================
/** Hard cap on the free-text fields — reject rather than truncate. The password
 *  cap matters most: it's enforced BEFORE hashPassword so an unbounded input
 *  can't be used to grind multi-MB argon2 hashes on this endpoint. */
const MAX_ACCEPT_FIELD_LENGTH = 200;

export interface AcceptInviteAsNewUserInput {
  /** Optional display name — the only free-text field. Identity (email) is
   *  never taken from here; it comes from the invite record. */
  name?: string;
  password: string;
  confirmPassword: string;
}

export async function acceptInviteAsNewUser(
  token: string,
  input: AcceptInviteAsNewUserInput,
): Promise<AcceptInviteActionResult> {
  // 1. The token must resolve to a still-pending invite. Validated BEFORE any
  //    write; a token that went stale between page load and submit
  //    (used/revoked/expired) is rejected here with the same copy the accept
  //    page and acceptInvitation() use.
  const inv = await getInvitationByToken(token);
  if (!inv) {
    return { ok: false, reason: "This invitation link is invalid." };
  }
  const status = invitationStatus(inv, new Date());
  if (status !== "pending") {
    return { ok: false, reason: reasonForNonPending(status) };
  }

  // 2. The invited email must NOT already have an account. An existing account
  //    signs in and uses acceptInviteAction instead; this path is only ever
  //    for a brand-new account. Re-checked as a unique-violation fallback at
  //    step 4 for the concurrent-signup race — never a duplicate, never a
  //    password overwrite on an existing account.
  const existing = await findUserByEmail(inv.email);
  if (existing) {
    return { ok: false, reason: "This email already has an account. Sign in instead." };
  }

  // 3. Password checks, SERVER-SIDE (never trust the client's own copies).
  //    Same strength policy /api/register enforces, keyed on the invited email
  //    so the password can't just be that address.
  if (input.password !== input.confirmPassword) {
    return { ok: false, reason: "Passwords don't match." };
  }
  // Length caps BEFORE hashing — an unbounded password would let a caller grind
  // multi-MB argon2 hashes here; the name is capped for the same hygiene (it
  // goes straight to the DB). Both reject rather than silently truncate.
  if (input.password.length > MAX_ACCEPT_FIELD_LENGTH) {
    return { ok: false, reason: `Password must be ${MAX_ACCEPT_FIELD_LENGTH} characters or fewer.` };
  }
  const trimmedName = typeof input.name === "string" ? input.name.trim() : "";
  if (trimmedName.length > MAX_ACCEPT_FIELD_LENGTH) {
    return { ok: false, reason: `Name must be ${MAX_ACCEPT_FIELD_LENGTH} characters or fewer.` };
  }
  const strengthError = validatePasswordStrength(input.password, inv.email);
  if (strengthError) {
    return { ok: false, reason: strengthError };
  }

  // 4. Create the ACTIVE account. The email is the INVITE's, normalised — see
  //    this section's header on the deliberate domain-restriction bypass.
  let created: User;
  try {
    created = await createUser({
      email: normalizeEmail(inv.email),
      name: trimmedName.length > 0 ? trimmedName : null,
      passwordHash: await hashPassword(input.password),
      status: "active",
    });
  } catch (err) {
    // A concurrent signup for the same email won the INSERT between the step-2
    // check and here (the race lib/users.ts's createUser header documents) —
    // same friendly result as step 2. The invite is left untouched (not
    // consumed) since we never created a user on this call.
    if (isUniqueViolation(err)) {
      return { ok: false, reason: "This email already has an account. Sign in instead." };
    }
    throw err;
  }

  // 5. Grant membership + mark the invite accepted (single-use), via the exact
  //    same claim-before-grant path a signed-in accept uses.
  const accepted = await acceptInvitation(token, { id: created.id, email: created.email });
  if (!accepted.ok) {
    // The token was consumed/revoked in the gap after createUser, so NO
    // membership was granted. The account we just made would be a permanent
    // orphan — active, with a password, but with no membership: it can never
    // log in (credentials-auth requires one) AND it blocks a re-invite
    // (findUserByEmail would now find it, so this path would reject the email
    // as "already has an account"). Compensating rollback: delete it so the
    // email returns to pristine and a fresh invite works normally. If the
    // rollback delete itself fails, return acceptInvitation's ORIGINAL result
    // rather than mask it with a delete error — the orphan is inert (unloggable)
    // either way.
    try {
      await deleteUser(created.id);
    } catch {
      // swallow — the original acceptInvitation failure below is the meaningful
      // outcome; a failed cleanup must not turn into a different error.
    }
  }
  return accepted;
}

// ============================================================================
// acceptInviteAsPendingUser — the ACTIVATE-ON-ACCEPT path (issue #25).
// ----------------------------------------------------------------------------
// The third door into an org, for an invitee who ALREADY has a `pending`
// account — a staff member who self-registered on the org's verified domain
// (app/api/register/route.ts creates them `pending`, awaiting approval) and is
// then invited. Before this, that person was stuck: the create path is skipped
// (an account exists), the one-click confirm needs status === "active", the
// signed-in acceptInviteAction rejects a non-active account, and a pending
// account can't sign in — so the invite silently no-oped. The invite IS that
// approval, so redeeming it here activates the account and grants the role.
//
// 🔴 SAME BEARER MODEL as acceptInviteAsNewUser — no session required (a pending
// account can't sign in, which is the whole gap). Holding a valid single-use
// invite for inv.email is the authorization, bounded to that exact address:
//   - The account activated is the one the invite is FOR (findUserByEmail(inv.email)),
//     never an address from a form or a session.
//   - The claim runs FIRST (acceptInvitation below), BEFORE the activation: it
//     re-checks the invite resolves, is still pending, matches the email, and
//     enforces single-use with its claim-before-grant. An account is therefore
//     NEVER activated except by a call that actually won the claim on a valid,
//     unredeemed, unexpired invite for its own email.
//   - Only a `pending` account is ever touched — an `active` account is a
//     different door (acceptInviteAction), and a `suspended` account is never
//     reactivated by redeeming an invite.
//
// Activation is exactly approvePendingUser's write (setUserStatus(id,'active'),
// app/admin/members/actions.ts) — redemption on the invited email is treated as
// the admin approval it stands in for.
// ============================================================================
export async function acceptInviteAsPendingUser(token: string): Promise<AcceptInviteActionResult> {
  // 1. The token must resolve to a still-pending invite — validated BEFORE any
  //    write, mirroring acceptInviteAsNewUser's step 1.
  const inv = await getInvitationByToken(token);
  if (!inv) {
    return { ok: false, reason: "This invitation link is invalid." };
  }
  const status = invitationStatus(inv, new Date());
  if (status !== "pending") {
    return { ok: false, reason: reasonForNonPending(status) };
  }

  // 2. The invited email must have a PENDING account. Any other state is a
  //    different door and is refused here (defence in depth for a direct call
  //    or a state that changed between page load and submit): no account →
  //    acceptInviteAsNewUser; active → acceptInviteAction; suspended → never
  //    reactivated via an invite.
  const existing = await findUserByEmail(inv.email);
  if (!existing) {
    return { ok: false, reason: "This email doesn't have an account to activate. Open the invitation link again to create one." };
  }
  if (existing.status !== "pending") {
    return { ok: false, reason: "This account isn't awaiting approval. Reload the page to see its current status." };
  }

  // 3. Claim the invite + grant membership FIRST — the atomic gate that proves
  //    the invite was valid, unredeemed, unexpired AND for this exact email, and
  //    enforces single-use (see lib/invitations.ts's claim-before-grant). Only a
  //    call that actually wins the claim reaches the activation below.
  const accepted = await acceptInvitation(token, { id: existing.id, email: existing.email });
  if (!accepted.ok) {
    return accepted;
  }

  // 4. Redemption IS the approval: flip pending → active, the exact write
  //    approvePendingUser makes. Membership is already granted (step 3); this
  //    clears credentials-auth's login gate so the account can finally sign in.
  await setUserStatus(existing.id, "active");

  return accepted;
}

/** A non-"pending" invite → the same user-facing copy acceptInvitation() uses,
 *  so the accept page and this action never describe the same state two
 *  different ways. */
function reasonForNonPending(status: Exclude<InvitationStatus, "pending">): string {
  if (status === "accepted") return "This invitation has already been used.";
  if (status === "revoked") return "This invitation has been revoked.";
  return "This invitation has expired.";
}
