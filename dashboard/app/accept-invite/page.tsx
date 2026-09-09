// ============================================================================
// /accept-invite — redeem an org invitation (Task C).
// ----------------------------------------------------------------------------
// The page an invite link points at. Resolves the raw token from the query
// string and branches on the invite's state; the actual account creation /
// membership grant happen in app/accept-invite/actions.ts, never here.
//
// The PRIMARY visitor is an off-domain consultant/QA with NO account (see
// lib/invitations.ts's header) — they get the create-account form
// (AcceptInviteForm), which is the only way into an org that bypasses the
// registration domain restriction. An invitee who already has an account, and
// is signed in as that exact address, gets a one-click confirm instead.
//
// Reachable WITHOUT a session: this page never calls requireRole/redirect. The
// root layout's tenant gate (app/layout.tsx) still applies — the invite link
// is always built on the org's own subdomain (app/admin/members/actions.ts's
// currentOrigin), so the tenant resolves and the page renders for a signed-out
// visitor.
//
// Anti-enumeration: none of the error states below reveal whether an email has
// an account — they only describe the INVITE's state (invalid / used / revoked
// / expired), which the visitor already learns nothing new from (they hold the
// link).
// ============================================================================
import type { ReactNode } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  emailMatchesInvitation,
  getInvitationByToken,
  invitationStatus,
  type InvitationRole,
  type InvitationStatus,
} from "@/lib/invitations";
import { getOrgById, readOrgSlugHeader } from "@/lib/org";
import { hostForOrgSlug } from "@/lib/subdomain";
import { findUserByEmail } from "@/lib/users";
import { AcceptInviteForm } from "./AcceptInviteForm";
import { acceptInviteAction, acceptInviteAsPendingUser } from "./actions";

export const dynamic = "force-dynamic";

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;

  if (!token) {
    return (
      <InviteShell title="Invalid link">
        <ErrorBody>
          This invitation link is missing its token. Ask whoever invited you to send the full
          link again.
        </ErrorBody>
      </InviteShell>
    );
  }

  // token is now narrowed to string. Capture it as a plain string const so the
  // confirm-form server-action closure below stays typed — a closure re-widens
  // a narrowed outer variable back to string | undefined otherwise.
  const validToken: string = token;

  const inv = await getInvitationByToken(validToken);
  const status: InvitationStatus | null = inv ? invitationStatus(inv, new Date()) : null;

  if (!inv || status !== "pending") {
    return <StatusError status={status} />;
  }

  // Branding-origin match (issue #26). getInvitationByToken is NOT host-scoped,
  // so this page can load on a DIFFERENT org's subdomain than the invite belongs
  // to — the tenant shell (app/layout.tsx) would then brand to the HOST's org,
  // not the invite's. When the host names a different org (and there is a per-org
  // origin to point at), bounce to the invite's own origin so the whole page
  // matches. Can't loop: after the redirect the host resolves to inv.orgId and
  // this is a no-op. Best-effort — on hosts with no per-org subdomain (legacy
  // production, bare localhost, *.vercel.app) hostForOrgSlug returns null and the
  // page renders in place, content already correct via getOrgById(inv.orgId).
  const currentSlug = await readOrgSlugHeader();
  if (currentSlug !== inv.orgId) {
    const h = await headers();
    const targetHost = hostForOrgSlug(h.get("host"), inv.orgId);
    if (targetHost) {
      const proto = h.get("x-forwarded-proto") ?? (targetHost.includes(".localhost") ? "http" : "https");
      redirect(`${proto}://${targetHost}/accept-invite?token=${encodeURIComponent(validToken)}`);
    }
  }

  const org = await getOrgById(inv.orgId);
  const orgName = org?.name ?? inv.orgId;
  const existing = await findUserByEmail(inv.email);

  // ---- Primary path: brand-new, off-domain account -> the create form. ----
  if (!existing) {
    return (
      <InviteShell title={<JoinTitle orgName={orgName} />}>
        <InviteFacts orgName={orgName} email={inv.email} role={inv.role} />
        <AcceptInviteForm token={validToken} role={inv.role} email={inv.email} />
        <SignInHint />
      </InviteShell>
    );
  }

  // ---- The invited email has a PENDING account (self-registered on the org's
  //      domain, awaiting approval). The invite IS that approval: one click
  //      activates the account and grants the invited role. No session needed —
  //      a pending account can't sign in yet, which is the whole gap this closes
  //      (issue #25). Every security decision is server-side in
  //      acceptInviteAsPendingUser (claim-before-activate). ----
  if (existing.status === "pending") {
    // Capture as a plain string const so the server-action closure below stays
    // typed — a closure re-widens the narrowed `inv` back to nullable otherwise
    // (same reason validToken is captured above).
    const inviteEmail: string = inv.email;
    async function activateAndJoin() {
      "use server";
      const result = await acceptInviteAsPendingUser(validToken);
      // Activated but not signed in (no session on this path) — send them to
      // sign in with the address they already set a password for.
      if (result.ok) redirect(`/signin?email=${encodeURIComponent(inviteEmail)}`);
      redirect(`/accept-invite?token=${encodeURIComponent(validToken)}&error=1`);
    }

    return (
      <InviteShell title={<JoinTitle orgName={orgName} />}>
        <InviteFacts orgName={orgName} email={inv.email} role={inv.role} />
        <p className="text-sm leading-relaxed text-muted">
          Your account for <span className="font-mono text-xs text-fg">{inv.email}</span> is waiting
          on approval. Accepting activates it and adds you to {orgName} as {inv.role}.
        </p>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-line-strong bg-surface px-4 py-3 text-sm leading-relaxed text-muted"
          >
            That didn&apos;t go through — the invitation may have just been used, revoked, or
            expired. Reload the page to see its current status.
          </p>
        )}
        <form action={activateAndJoin}>
          <button type="submit" className="btn-primary w-full py-3">
            Activate and join {orgName} as {inv.role}
          </button>
        </form>
      </InviteShell>
    );
  }

  // ---- An active (or suspended) account already exists for the invited email. ----
  const session = await auth();
  const sessionEmail = session?.user?.email ?? null;
  const signedInAsInvitee = sessionEmail !== null && emailMatchesInvitation(inv, sessionEmail);

  if (signedInAsInvitee && existing.status === "active") {
    // Signed in AS the invited, active person — a one-click confirm that hands
    // off to the EXISTING acceptInviteAction (it re-checks status, email-match
    // and the domain bypass server-side; nothing security-relevant is decided
    // in this component).
    async function confirmJoin() {
      "use server";
      const result = await acceptInviteAction(validToken);
      if (result.ok) redirect("/");
      redirect(`/accept-invite?token=${encodeURIComponent(validToken)}&error=1`);
    }

    return (
      <InviteShell title={<JoinTitle orgName={orgName} />}>
        <InviteFacts orgName={orgName} email={inv.email} role={inv.role} />
        <p className="text-sm leading-relaxed text-muted">
          You&apos;re signed in as <span className="font-mono text-xs text-fg">{inv.email}</span>.
          Accept to join {orgName} as {inv.role}.
        </p>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-line-strong bg-surface px-4 py-3 text-sm leading-relaxed text-muted"
          >
            That didn&apos;t go through — the invitation may have just been used, revoked, or
            expired. Reload the page to see its current status.
          </p>
        )}
        <form action={confirmJoin}>
          <button type="submit" className="btn-primary w-full py-3">
            Join {orgName} as {inv.role}
          </button>
        </form>
      </InviteShell>
    );
  }

  // The account exists but the current visitor isn't signed in as that exact
  // address (signed out, or signed in as someone else). Point them at the
  // right address without confirming or denying anything about the account.
  //
  // DELIBERATE FOLLOW-UP, not solved here: an existing account that is
  // Google-only (no password) or whose only session is in a DIFFERENT org has
  // no clean way to prove control of inv.email and redeem this invite in one
  // pass — the "sign in as them" hop can deadlock. Proving identity for an
  // existing cross-org account is its own task; this page only points the way.
  return (
    <InviteShell title={<JoinTitle orgName={orgName} />}>
      <InviteFacts orgName={orgName} email={inv.email} role={inv.role} />
      <ErrorBody>
        This invitation is for <span className="font-mono text-xs text-fg">{inv.email}</span>. Sign
        in as that address to accept it.
      </ErrorBody>
      <Link href={`/signin?email=${encodeURIComponent(inv.email)}`} className="btn-primary w-full py-3">
        Sign in to accept
      </Link>
    </InviteShell>
  );
}

// ---------------------------------------------------------------------------
// Presentational pieces (server components — no client JS needed).
// ---------------------------------------------------------------------------

function InviteShell({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-line bg-bg-deep p-8 shadow-[0_24px_64px_-32px_rgba(0,0,0,0.4)]">
        <div className="space-y-3 text-center">
          <div className="text-4xl" aria-hidden="true">
            🌶
          </div>
          <p className="eyebrow">Invitation</p>
          <h1 className="font-display text-2xl font-bold tracking-tight text-fg">{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

function JoinTitle({ orgName }: { orgName: string }) {
  return (
    <>
      Join <span className="serif-accent">{orgName}</span>
    </>
  );
}

function InviteFacts({
  orgName,
  email,
  role,
}: {
  orgName: string;
  email: string;
  role: InvitationRole;
}) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
      <dt className="text-faint">Workspace</dt>
      <dd className="text-right text-fg">{orgName}</dd>
      <dt className="text-faint">Email</dt>
      <dd className="truncate text-right font-mono text-xs text-fg">{email}</dd>
      <dt className="text-faint">Role</dt>
      <dd className="text-right font-mono text-xs text-accent">{role}</dd>
    </dl>
  );
}

function ErrorBody({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-line-strong bg-surface px-4 py-3 text-sm leading-relaxed text-muted"
    >
      {children}
    </div>
  );
}

function SignInHint() {
  return (
    <p className="text-center text-sm text-muted">
      Already have an account?{" "}
      <Link href="/signin" className="font-medium text-accent hover:underline">
        Sign in
      </Link>
    </p>
  );
}

/** Invalid (no such token) or non-pending (used / revoked / expired) invite —
 *  distinct, clearly-worded copy per state, none of it leaking whether any
 *  email has an account. */
function StatusError({ status }: { status: InvitationStatus | null }) {
  const copy = statusCopy(status);
  return (
    <InviteShell title={copy.title}>
      <ErrorBody>{copy.body}</ErrorBody>
      {copy.showSignIn && <SignInHint />}
    </InviteShell>
  );
}

function statusCopy(status: InvitationStatus | null): {
  title: string;
  body: string;
  showSignIn: boolean;
} {
  switch (status) {
    case "accepted":
      return {
        title: "Already used",
        // Deliberately does NOT promise that signing in will work: an invite can
        // read "accepted" without the accepting account ending up with usable
        // access. Offer sign-in as a possibility, with a clear fallback.
        body: "This invitation has already been used. If that was you and your account is set up, you can sign in. If sign-in doesn't work, or it wasn't you, contact whoever invited you to be re-invited.",
        showSignIn: true,
      };
    case "revoked":
      return {
        title: "Invitation revoked",
        body: "This invitation has been revoked. If you think that's a mistake, contact whoever invited you for a new one.",
        showSignIn: false,
      };
    case "expired":
      return {
        title: "Invitation expired",
        body: "This invitation has expired — invitations are good for 7 days. Ask whoever invited you to send a fresh one.",
        showSignIn: false,
      };
    default:
      // null — no invitation resolves to this token.
      return {
        title: "Invalid link",
        body: "This invitation link isn't valid. It may have been mistyped, or replaced by a newer invite to the same person. Ask whoever invited you to send a fresh link.",
        showSignIn: false,
      };
  }
}
