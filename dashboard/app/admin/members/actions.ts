"use server";

// ============================================================================
// Approve a pending member — requirement 3(b)'s second way out of "pending"
// (the first being a clicked email-verification link, which has no real
// implementation yet — see lib/email-verification.ts).
// ----------------------------------------------------------------------------
// Role-gated via requireRole("admin") (lib/authz.ts) — the SAME gate the invite
// actions below use. Two independent checks, both required — this is exactly the
// kind of authorization code where "checked one thing and assumed the other" is
// the whole bug:
//   1. the CALLER's role — re-derived from the `membership` table on every call
//      by requireRole, NEVER trusted from the JWT. A demoted/suspended/removed
//      admin is stopped on their very next click, not up to 30 days later when
//      the session token expires (see lib/authz.ts's header). requireRole also
//      hands back the caller's own DB-derived orgId, which scopes check 2.
//   2. the TARGET's membership — re-fetched by (userId, the CALLER's own orgId
//      from the gate), not assumed from whatever org the pending-members list
//      page queried. An admin of org A can only ever approve a pending user IN
//      org A, even if (hypothetically) they passed a userId belonging to org B
//      — that lookup would come back null and this rejects.
// ============================================================================
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { DEV_NO_AUTH_USER_ID, requireRole } from "@/lib/authz";
import { sendInvitationEmail } from "@/lib/email";
import { createInvitation, isInvitationRole, revokeInvitation } from "@/lib/invitations";
import { getMembership } from "@/lib/membership";
import { getOrgById, readOrgSlugHeader } from "@/lib/org";
import { getUserById, setUserStatus } from "@/lib/users";

export type ApproveResult = { ok: true } | { ok: false; error: string };

export async function approvePendingUser(userId: string): Promise<ApproveResult> {
  const gate = await requireRole("admin");
  if (!gate.ok) return { ok: false, error: gate.error };

  const membership = await getMembership(userId, gate.orgId);
  if (!membership) {
    return { ok: false, error: "That user isn't a member of your organization." };
  }

  const user = await getUserById(userId);
  if (!user) {
    return { ok: false, error: "User not found." };
  }
  if (user.status !== "pending") {
    return { ok: false, error: "That user isn't pending approval." };
  }

  await setUserStatus(userId, "active");
  revalidatePath("/admin/members");
  return { ok: true };
}

// ============================================================================
// Invite + revoke — the invite half of member onboarding.
// ----------------------------------------------------------------------------
// Both actions call lib/authz.ts's requireRole("admin") FIRST — it re-derives
// the caller's role from the database on every call, so a demoted/suspended/
// removed admin is stopped on their very next click, not up to 30 days later
// when their session JWT expires (see lib/authz.ts's header). requireRole also
// hands back the caller's own orgId/userId already re-derived from the DB, so
// every read/write below is TENANT-SCOPED to gate.orgId, never a client-
// supplied org. Changing a member's role and removing a member live in
// app/settings (app/settings/actions.ts, with lib/member-permissions' privilege
// model) — this file owns only self-registration approvals and invites.
// ============================================================================

const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // mirrors app/api/register/route.ts's own check

/**
 * This request's own origin (scheme + host), built from its Host header — used
 * only to construct the accept-invite link handed back to the admin
 * (lib/email.ts's sendInvitationEmail always returns false today — no provider
 * configured — so that link is the actual delivery mechanism, not a courtesy
 * copy). Reads next/headers() rather than any hardcoded/env base URL, so the
 * link always matches whatever host the admin is looking at this page from —
 * sanjow.optimiser.pro in prod, sanjow.localhost:3000 or plain localhost:3000
 * in dev.
 */
async function currentOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const forwardedProto = h.get("x-forwarded-proto");
  const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  const proto = forwardedProto ?? (isLocal ? "http" : "https");
  return `${proto}://${host}`;
}

export type InviteMemberResult =
  | { ok: true; inviteUrl: string; emailed: boolean }
  | { ok: false; error: string };

/**
 * Invite `email` to join the caller's org at `role`. Always returns the
 * accept-invite URL (`inviteUrl`) regardless of `emailed` — lib/email.ts's
 * sendInvitationEmail has no real provider wired up yet and always returns
 * false (see that module's header), so the admin members page shows this URL
 * directly for the admin to copy and send by whatever channel they like. That
 * URL is only ever available here, at creation time — the raw token is never
 * persisted (lib/invitations.ts's createInvitation stores only its hash), so
 * this response is the one and only chance to see it.
 */
export async function inviteMember(email: string, role: string): Promise<InviteMemberResult> {
  const gate = await requireRole("admin");
  if (!gate.ok) return { ok: false, error: gate.error };

  const trimmedEmail = email.trim();
  if (!EMAIL_SHAPE_RE.test(trimmedEmail)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (!isInvitationRole(role)) {
    return { ok: false, error: "Choose admin, editor, or viewer for an invite." };
  }

  // Host validation (issue #26). The invite link below embeds THIS request's Host
  // (currentOrigin), and the admin forwards that link to the invitee — a forged
  // Host would poison it, pointing the invitee at an attacker origin. Refuse to
  // build a link on a Host that doesn't resolve to the caller's OWN org.
  // readOrgSlugHeader is the Host middleware.ts already parsed into a slug, with
  // any inbound copy deleted first (so it's trusted), and organization.id IS that
  // slug (lib/org.ts) — so it compares straight to gate.orgId. Minimal guard now,
  // ahead of server-side email delivery going live; the invite is not created on
  // a mismatch.
  const hostSlug = await readOrgSlugHeader();
  if (hostSlug !== gate.orgId) {
    return {
      ok: false,
      error: "This invite couldn't be created from this address. Open the members page on your workspace's own URL and try again.",
    };
  }

  // requireRole()'s WASABI_DEV_NO_AUTH bypass (lib/authz.ts) hands back the
  // synthetic DEV_NO_AUTH_USER_ID, which has no matching row in "user" —
  // invitation.invited_by is a real FK to that table (lib/db.ts), so passing
  // the sentinel straight through 23503s. Nullable column, real gap only under
  // the dev-only bypass (impossible in any deployed environment — see
  // lib/authz.ts's own guard on that flag), so fail soft to "unattributed"
  // rather than let a local-dev invite crash.
  const invitedBy = gate.userId === DEV_NO_AUTH_USER_ID ? null : gate.userId;
  const created = await createInvitation(gate.orgId, trimmedEmail, role, invitedBy);

  const org = await getOrgById(gate.orgId);
  const inviteUrl = `${await currentOrigin()}/accept-invite?token=${created.rawToken}`;
  const emailed = await sendInvitationEmail({
    email: created.invitation.email,
    orgName: org?.name ?? gate.orgId,
    inviteUrl,
  });

  revalidatePath("/admin/members");
  return { ok: true, inviteUrl, emailed };
}

export type RevokeInviteResult = { ok: true } | { ok: false; error: string };

/** Revoke a still-pending invite. Tenant-scoped by gate.orgId inside
 *  lib/invitations.ts's revokeInvitation — an invite id belonging to a
 *  different org (or already used/revoked/expired) matches no row and comes
 *  back null, indistinguishable from "doesn't exist". */
export async function revokeInvite(invitationId: string): Promise<RevokeInviteResult> {
  const gate = await requireRole("admin");
  if (!gate.ok) return { ok: false, error: gate.error };

  const revoked = await revokeInvitation(invitationId, gate.orgId);
  if (!revoked) {
    return {
      ok: false,
      error: "That invite couldn't be found — it may already be revoked, used, or expired.",
    };
  }

  revalidatePath("/admin/members");
  return { ok: true };
}
