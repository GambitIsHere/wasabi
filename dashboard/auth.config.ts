// ============================================================================
// Shared Auth.js config — the EDGE-SAFE half. Split from auth.ts specifically
// so middleware.ts can use it directly.
// ----------------------------------------------------------------------------
// Next.js middleware runs on the Edge, which cannot load native Node addons.
// The Credentials provider's authorize() needs lib/password.ts, which wraps
// @node-rs/argon2 — a napi-rs NATIVE BINARY. If middleware imported the same
// `auth` export as the real route handler (i.e. one that includes the
// Credentials provider), Next's Edge bundler would need to bundle that native
// binding too, which fails. So:
//   - THIS file: Google provider only + every callback — none of which touch
//     lib/password.ts (verified: signIn's Google branch uses lib/org.ts +
//     lib/users.ts + lib/membership.ts, all Neon-HTTP-driver + next/headers,
//     both Edge-compatible; jwt/session touch nothing but the token/session
//     objects themselves). middleware.ts imports `auth` FROM THIS FILE.
//   - auth.ts: spreads this config, ADDS the Credentials provider (and so
//     lib/password.ts) on top, and is used by app/api/auth/[...nextauth]/
//     route.ts (Node runtime, no Edge bundling concern) and every Server
//     Action/Component that needs `auth()`/`signIn()`/`signOut()`.
//
// This is the standard Auth.js v5 + Next.js middleware pattern for a config
// that mixes an Edge-safe provider with a Node-only one.
// ============================================================================
import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { emailMatchesDomain } from "@/lib/domain-restriction";
import { resolveOrgFromRequestHeader } from "@/lib/org";
import { createUser, findUserByEmail, normalizeEmail } from "@/lib/users";
import { determineRoleForNewMembership, findOrCreateMembership } from "@/lib/membership";

export const authConfig = {
  providers: [Google],
  pages: {
    signIn: "/signin",
  },
  callbacks: {
    // Reject any Google account whose email isn't in the RESOLVED ORG's
    // verified domain (requirement 4 — the org record is now the source of
    // truth, AUTH_ALLOWED_EMAIL_DOMAIN is only a fallback for an org that
    // hasn't set verified_domain). Fails closed at every step: unresolvable
    // org, no domain configured anywhere, non-matching email, or a
    // suspended/pending existing account all reject.
    //
    // For the Credentials provider this is a no-op passthrough — its
    // authorize() (auth.ts) already fully vetted the account (password,
    // status==='active', membership in the resolved org) before `user` ever
    // reaches here; re-deriving the same checks from a DIFFERENT signal
    // (account.provider) would just be duplicated logic with more surface
    // area for the two copies to drift.
    async signIn({ user, account }) {
      if (account?.provider !== "google") return true;
      if (!user.email) return false;

      const org = await resolveOrgFromRequestHeader();
      if (!org) return false; // can't resolve the org this sign-in is for — never guess

      const allowedDomain = org.verifiedDomain ?? process.env.AUTH_ALLOWED_EMAIL_DOMAIN;
      if (!allowedDomain) return false; // no domain configured anywhere — fail closed, not "allow anything"
      if (!emailMatchesDomain(user.email, allowedDomain)) return false;

      // Find-or-create the user row. Google sign-in never goes through the
      // "pending" gate that self-registration does (app/api/register/route.ts)
      // — the Workspace domain restriction IS the identity check here, same
      // as it always was pre-Batch-D-a; Google has already verified this
      // person controls this email address, which self-registration cannot
      // claim without a working email sender (see lib/email-verification.ts).
      const normalizedEmail = normalizeEmail(user.email);
      let dbUser = await findUserByEmail(normalizedEmail);
      if (!dbUser) {
        dbUser = await createUser({
          email: normalizedEmail,
          name: user.name ?? null,
          image: user.image ?? null,
          status: "active",
          emailVerifiedAt: new Date().toISOString(), // Google already verified this address
        });
      }
      // A pre-existing account that isn't active (suspended, or "pending"
      // from an earlier password self-registration of the same email) does
      // NOT get fast-tracked to access via Google — the only two paths out
      // of "pending" are the ones app/api/register/route.ts documents
      // (email verification or admin approval). Deliberately conservative:
      // reasonable people could argue Google's own verification is at least
      // as strong a proof of identity, but that's a product decision this
      // batch doesn't make silently.
      if (dbUser.status !== "active") return false;

      // dbUser is guaranteed active here (the status check above rejects
      // otherwise), so this Google sign-in can bootstrap a fresh org to owner —
      // Google has already verified this identity (I13's active-only rule).
      const role = await determineRoleForNewMembership(org.id, true);
      const membership = await findOrCreateMembership(dbUser.id, org.id, role);

      // Mutate `user` IN PLACE — verified against @auth/core's source
      // (lib/actions/callback/index.ts's handleAuthorized + handleLoginOrRegister):
      // with no database adapter configured (this app has none — see this
      // repo's original auth.ts header), handleLoginOrRegister short-circuits
      // to `{ user: _profile }`, i.e. the SAME object reference passed into
      // this callback, unchanged. Whatever we set on `user` here is exactly
      // what the jwt callback's first (sign-in) invocation receives.
      user.id = dbUser.id; // OUR id, not Google's `sub` — one canonical id regardless of sign-in method
      user.orgId = org.id;
      user.role = membership.role;
      return true;
    },

    // Bake orgId/role into the JWT ONLY at sign-in (`user` is only present
    // then — see the @auth/core JSDoc on this callback's `user` param).
    // Every OTHER invocation (including the one middleware.ts's auth() wrapper
    // triggers on literally every gated request, to decode/refresh the
    // existing token) hits neither branch below and does zero I/O — this is
    // both what makes it Edge-safe AND what requirement 5 asks for (session
    // carries org+role so server code can authorize without a DB round-trip
    // per render). A role change (Batch D-b) therefore only takes effect on
    // this user's NEXT sign-in, not live — a standard, documented trade-off
    // of JWT-cached claims.
    async jwt({ token, user }) {
      if (user) {
        token.orgId = user.orgId;
        token.role = user.role;
      }
      return token;
    },

    // Auth.js only exposes a subset of the token on `session` by default —
    // orgId/role must be explicitly copied across, same as any other custom
    // claim (see the callback's own doc comment in @auth/core).
    async session({ session, token }) {
      session.orgId = token.orgId;
      session.role = token.role;
      return session;
    },
  },
  // Required on Vercel (and any reverse-proxied deploy) for Auth.js v5 to
  // accept the Host header as-is when building callback URLs.
  trustHost: true,
} satisfies NextAuthConfig;
