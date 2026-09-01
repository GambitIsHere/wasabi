// ============================================================================
// Email verification seam (server-only) — deliberately not a real sender.
// ----------------------------------------------------------------------------
// Requirement 3(a): a self-registered user can reach "active" either by
// clicking an emailed verification link OR by an org owner/admin approving
// them (lib/membership.ts's listPendingMembersForOrg + the approve action).
// Wiring up an actual email provider (and the token/route that a link would
// need to land on) is explicitly OUT OF SCOPE for this batch — see the
// batch spec. What ships here is the SEAM: one function, called from
// app/register-actions.ts on every registration, that a follow-up batch
// swaps for a real provider without touching the registration flow at all.
//
// isEmailProviderConfigured() is the single source of truth for "do we have
// a sender" — app/register-actions.ts uses it to decide which success
// message to show (check your email vs. an admin will need to approve you),
// and this file's own header/`.env.example`'s comment make the unconfigured
// state impossible to miss rather than something that silently no-ops.
// ============================================================================

/** RESEND_API_KEY is the placeholder convention (Resend is the common choice
 *  for a Next.js/Vercel stack) — no @resend/node dependency is installed and
 *  no route exists for a verification link to land on, so setting this key
 *  today would NOT make verification emails start sending; it only flips
 *  isEmailProviderConfigured() to true, which sendVerificationEmail() below
 *  would then need a real implementation to honour. Documented in
 *  .env.example alongside every other optional integration. */
function isEmailProviderConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export interface VerificationEmailTarget {
  id: string;
  email: string;
}

/**
 * Attempt to send a verification email. Returns whether it actually sent.
 * Today this is ALWAYS false — there is no provider wired up (see the module
 * header) — logging once per call so the gap stays visible in server logs
 * instead of silently vanishing. Never throws: a broken/unconfigured sender
 * must never block registration itself (the user still gets created as
 * "pending" either way — see app/register-actions.ts).
 */
export async function sendVerificationEmail(target: VerificationEmailTarget): Promise<boolean> {
  if (!isEmailProviderConfigured()) {
    console.warn(
      `[email-verification] no email provider configured (RESEND_API_KEY unset) — cannot send a ` +
        `verification email to ${target.email}. This account stays "pending" until an org owner/admin ` +
        "approves it. See .env.example.",
    );
    return false;
  }
  // No real provider integration exists yet — see this module's header. If
  // isEmailProviderConfigured() above is ever made reachable (RESEND_API_KEY
  // set), this branch needs a real implementation before it can return true;
  // it deliberately does NOT fall through to a fake "sent" response.
  console.warn(
    "[email-verification] RESEND_API_KEY is set, but no send implementation exists yet in this " +
      "batch — treating as unsent. Wiring up the actual provider is follow-up work.",
  );
  return false;
}
