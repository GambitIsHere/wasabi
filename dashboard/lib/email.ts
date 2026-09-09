// ============================================================================
// Email provider seam (server-only) — the shared "do we have a sender" truth,
// plus the invitation-email seam built on it.
// ----------------------------------------------------------------------------
// isEmailProviderConfigured() used to live only inside lib/email-verification.ts
// (Batch D-a). It moved here so lib/email-verification.ts's
// sendVerificationEmail() AND this file's sendInvitationEmail() share the
// exact same "is RESEND_API_KEY set" check — one definition, so the two seams
// can never silently disagree about whether a provider exists. See
// lib/email-verification.ts's header for the original rationale, which still
// applies verbatim.
//
// Wiring up an actual email provider (Resend, or anything else) is explicitly
// OUT OF SCOPE here, same as it was for verification — see this file's own
// functions below for what ships instead: a SEAM that always returns false
// today, loud in the server logs about why, and never blocks the caller's
// actual work (an invitation is created and usable via its raw link
// regardless of whether the email send "succeeds").
// ============================================================================

/** RESEND_API_KEY is the placeholder convention (Resend is the common choice
 *  for a Next.js/Vercel stack) — no @resend/node dependency is installed and
 *  no template/send call exists for either seam, so setting this key today
 *  would NOT make emails start sending; it only flips this function to true,
 *  which sendVerificationEmail()/sendInvitationEmail() would then each need a
 *  real implementation to honour. Documented in .env.example. */
export function isEmailProviderConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export interface InvitationEmailTarget {
  /** The invited person's email — NOT necessarily on the org's verified
   *  domain (that's the entire point of an invitation — see
   *  lib/invitations.ts's header). */
  email: string;
  /** Display name of the org they're being invited to. */
  orgName: string;
  /** The full accept-invite URL (raw token included) — built by the CALLER
   *  (Task B's admin action), since this module has no notion of the app's
   *  own host/base URL. Never persisted anywhere (see lib/invitations.ts's
   *  createInvitation — the raw token exists only transiently). */
  inviteUrl: string;
}

/**
 * Attempt to send an invitation email. Returns whether it actually sent.
 * Today this is ALWAYS false — there is no provider wired up (see this
 * module's header) — logging once per call so the gap stays visible in
 * server logs instead of silently vanishing. Never throws: a broken or
 * unconfigured sender must never block an invitation from being CREATED or
 * USED — the raw invite link (returned by lib/invitations.ts's
 * createInvitation) is the actual mechanism; email is a convenience on top
 * of it. When this returns false, the Task-B admin UI is expected to show
 * that link directly so the admin can hand it to the invitee some other way
 * (Slack, a DM, however) — invites work even with zero email provider
 * configured, by design.
 */
export async function sendInvitationEmail(target: InvitationEmailTarget): Promise<boolean> {
  if (!isEmailProviderConfigured()) {
    console.warn(
      `[email] no email provider configured (RESEND_API_KEY unset) — cannot send an invitation ` +
        `email to ${target.email} for "${target.orgName}". Show the invite link in the admin UI ` +
        "as a fallback instead. See .env.example.",
    );
    return false;
  }
  // No real provider integration exists yet — see this module's header. If
  // isEmailProviderConfigured() above is ever made reachable (RESEND_API_KEY
  // set), this branch needs a real implementation before it can return true;
  // it deliberately does NOT fall through to a fake "sent" response.
  console.warn(
    "[email] RESEND_API_KEY is set, but no send implementation exists yet — treating the " +
      `invitation email to ${target.email} as unsent. Wiring up the actual provider is follow-up work.`,
  );
  return false;
}
