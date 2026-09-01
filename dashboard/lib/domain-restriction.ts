// ============================================================================
// Email/domain restriction check — pure, shared by both sign-in paths.
// ----------------------------------------------------------------------------
// The SAME rule ("does this email belong to this org's allowed domain")
// gates Google sign-in (auth.config.ts's signIn callback) and password
// self-registration (app/api/register/route.ts) — extracted here once so the
// two never drift apart, and so it's unit-testable without going through
// either an Auth.js callback or a Route Handler (see
// lib/domain-restriction.test.ts).
// ============================================================================

/** Strip a leading "@" and normalise case/whitespace — so a domain read from
 *  either `organization.verified_domain` (stored plain, e.g. "sanjow.com")
 *  or AUTH_ALLOWED_EMAIL_DOMAIN (same convention) compares consistently. */
export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@+/, "");
}

/**
 * True when `email` ends with "@" + `domain`, case-insensitively. Both
 * requirement 3 (registration) and requirement 4 (Google) use this as their
 * ENTIRE domain check — deliberately just a suffix match, not a full email
 * validator (that's EMAIL_SHAPE_RE in app/api/register/route.ts / the
 * `type="email"` input's own browser validation).
 */
export function emailMatchesDomain(email: string, domain: string): boolean {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) return false;
  return email.trim().toLowerCase().endsWith(`@${normalizedDomain}`);
}
