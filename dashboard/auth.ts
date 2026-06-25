// ============================================================================
// Wasabi admin gate — Google SSO via Auth.js v5 (next-auth@beta).
// ----------------------------------------------------------------------------
// Replaces the previous basic-auth middleware. Sign-in is restricted to a
// single email domain (AUTH_ALLOWED_EMAIL_DOMAIN, normally sanjow.com), with
// two enforcement layers:
//
//   1. Google OAuth consent screen "User Type: Internal" on the Workspace
//      domain (set in Google Cloud Console) — only that Workspace can sign in.
//   2. The signIn callback below — fail-closed belt-and-braces in case the
//      consent screen ever flips to External.
//
// Public storefront API surface (/api/decide, /api/capture) is NOT gated by
// this — see middleware.ts for the public-prefix carve-out.
// ============================================================================
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [Google],
  pages: {
    signIn: "/signin",
  },
  callbacks: {
    // Reject any Google account whose email isn't in the allowed domain.
    // Without AUTH_ALLOWED_EMAIL_DOMAIN we fail closed (no one can sign in).
    async signIn({ user }) {
      const allowed = process.env.AUTH_ALLOWED_EMAIL_DOMAIN?.toLowerCase().trim();
      if (!allowed) return false;
      if (!user.email) return false;
      return user.email.toLowerCase().endsWith(`@${allowed}`);
    },
  },
  // Required on Vercel (and any reverse-proxied deploy) for Auth.js v5 to
  // accept the Host header as-is when building callback URLs.
  trustHost: true,
});
