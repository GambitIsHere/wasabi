// ============================================================================
// Wasabi admin gate — Google + password SSO via Auth.js v5 (next-auth@beta).
// ----------------------------------------------------------------------------
// The FULL config: auth.config.ts's Edge-safe base (Google + all callbacks —
// see that file's header for why the split exists) PLUS the Credentials
// provider, which needs Node-only lib/password.ts (argon2) and so must never
// be part of middleware.ts's Edge bundle. Used by app/api/auth/[...nextauth]/
// route.ts (Node runtime — no Edge concern) and every Server Action/Component
// that calls auth()/signIn()/signOut().
//
// SECURITY PROPERTIES (Credentials provider, requirement 3):
//   - Hashing: argon2id via lib/password.ts (@node-rs/argon2), OWASP-cited
//     params — see that file's header for the exact numbers.
//   - Constant-time verify: lib/password.ts's verifyPassword() delegates to
//     the library's own verify(), never a hand-rolled comparison.
//   - Generic errors: EVERY authorize() failure below — no such user, no
//     password set (Google-only account), wrong password, not "active"
//     (pending/suspended), no membership in the resolved org — throws the
//     SAME InvalidCredentialsError with the SAME message. A failed login
//     reveals nothing about which of those five things was true.
//   - Rate limiting: lib/rate-limit.ts's token bucket on TWO axes — a per-IP
//     bucket checked FIRST (before even reading the submitted credentials) so a
//     flood from one source is capped regardless of what's in the body, AND a
//     per-ACCOUNT bucket keyed on the email (independent of IP) so rotating IPs
//     can't grind a single account. Not a
//     literal HTTP 429: Auth.js's Credentials sign-in is fundamentally a
//     redirect-based flow (see handleAuthorized in @auth/core), so a rate
//     limit here surfaces via Auth.js's own error-code redirect
//     (/signin?error=CredentialsSignin&code=rate_limited — see
//     app/signin/page.tsx's signInWithPassword action, which catches this
//     and shows a distinct message), the same mechanism the existing Google
//     AccessDenied error already used before this batch.
//     app/api/register/route.ts, which this app fully owns end-to-end,
//     returns a literal 429 instead.
//   - Tenant isolation: authorize() resolves the org from the SAME trusted,
//     middleware-set header everything else uses (lib/org.ts), and requires
//     a membership row in THAT SPECIFIC org — a correct password for an
//     account that belongs to a different org does not grant access here.
//   - Fails closed: no resolvable org, no membership, wrong password, or a
//     non-"active" account all reject. There is no path in this file that
//     grants a session without every one of those checks passing.
//
// Public storefront API surface (/api/decide, /api/capture) is NOT gated by
// this — see middleware.ts for the public-prefix carve-out.
// ============================================================================
import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "./auth.config";
import { authorizeCredentials } from "@/lib/credentials-auth";
import { getClientIp } from "@/lib/get-client-ip";
import { normalizeEmail } from "@/lib/users";
// A plain top-level import (unlike lib/tenant.ts's dynamic ones) is safe
// here: auth.ts is never imported by scripts/migrate-tenancy.ts (that script
// only reaches lib/tenant.ts, which dynamically imports "@/auth"/"./org"
// specifically so IT stays script-safe — see that file's header), and
// auth.ts is deliberately excluded from middleware.ts's Edge bundle already
// (middleware.ts imports from ./auth.config, not from here — see that file's
// header for why). So neither of the two reasons for a dynamic import
// elsewhere in this batch applies to this file.
import { resolveOrgFromRequestHeader } from "@/lib/org";
import { perMinute, takeToken } from "@/lib/rate-limit";

/** Every credentials failure surfaces as exactly this — see this file's
 *  header comment on why login errors are deliberately indistinguishable. */
class InvalidCredentialsError extends CredentialsSignin {
  code = "invalid_credentials";
}

/** Distinct from InvalidCredentialsError on purpose: rate-limit rejection is
 *  IP-scoped, not account-scoped, so showing a different message here can't
 *  leak anything about whether an account exists. */
class RateLimitedError extends CredentialsSignin {
  code = "rate_limited";
}

// Per-IP: 8-attempt immediate burst (covers a legitimate user mistyping a
// password a few times, or a password manager retry), refilling at 4/minute
// sustained — tight enough to make online brute-forcing from one source
// impractical (argon2's own deliberate ~50-150ms-per-attempt cost already helps
// here too) without locking out someone who fat-fingers their password twice.
const LOGIN_IP_RATE_LIMIT = { capacity: 8, refillPerMs: perMinute(4) };

// Per-ACCOUNT: a slightly larger burst (a shared office IP, or the account owner
// retrying) refilling at 5/minute, keyed on the email and INDEPENDENT of IP.
// This is the axis a per-IP limiter can't cover: an attacker rotating IPs to
// grind one account draws every attempt from this single shared bucket. Token
// refill means it throttles rather than hard-locks, so it can't be abused to
// permanently lock a victim out.
const LOGIN_ACCOUNT_RATE_LIMIT = { capacity: 10, refillPerMs: perMinute(5) };

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    ...authConfig.providers,
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        // Per-IP cap FIRST, before reading/validating the submitted credentials,
        // so a flood of attempts is capped regardless of what's in the body —
        // mirrors /api/capture's "rate limit before the shared-secret check"
        // ordering (lib/rate-limit.ts's own header comment on why).
        if (!takeToken(getClientIp(request), LOGIN_IP_RATE_LIMIT)) {
          throw new RateLimitedError();
        }

        const email = typeof credentials?.email === "string" ? credentials.email : "";
        const password = typeof credentials?.password === "string" ? credentials.password : "";

        // Per-ACCOUNT cap SECOND, keyed on the email and independent of IP so an
        // attacker rotating IPs still hits one shared bucket per account. Same
        // normalisation as the user lookup so "Alice@x" and "alice@x" share it.
        if (email && !takeToken(`login:acct:${normalizeEmail(email)}`, LOGIN_ACCOUNT_RATE_LIMIT)) {
          throw new RateLimitedError();
        }

        // The org this login attempt is FOR — the same trusted,
        // middleware-set header lib/org.ts's other consumers use. Fail
        // closed if it doesn't resolve; never assume a default org for a
        // login attempt.
        const org = await resolveOrgFromRequestHeader();
        if (!org) throw new InvalidCredentialsError();

        // lib/credentials-auth.ts's authorizeCredentials() is the actual
        // gate — see its header comment for the full list of failure
        // reasons it collapses into one generic `null` (requirement 3's
        // anti-enumeration property).
        const authorized = await authorizeCredentials(email, password, org.id);
        if (!authorized) throw new InvalidCredentialsError();
        return authorized;
      },
    }),
  ],
});

// trustHost: true travels via the `...authConfig` spread above (a plain
// boolean property, so the spread carries it verbatim) — see auth.config.ts's
// header comment for why the Vercel/reverse-proxy Host-header trust lives
// there rather than being restated here.
