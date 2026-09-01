// ============================================================================
// Auth-gate predicate (pure, Edge-safe) — the one truthiness check middleware.ts
// decides "is this request signed in?" on.
// ----------------------------------------------------------------------------
// WHY THIS EXISTS AS ITS OWN FUNCTION (the C1 fail-open fix):
// next-auth's middleware wrapper sets `req.auth = await getSession(...).json()`
// with NO HTTP-status check (verified against next-auth@5.0.0-beta.31's
// lib/index.js handleAuth: `augmentedReq.auth = auth`). On the SUCCESS path
// @auth/core's session endpoint returns `{ user, expires, … }`. But on an
// ERROR path it returns a truthy NON-session body:
//   - missing/invalid AUTH_SECRET or any other config error →
//     `Response.json({ message }, { status: 500 })` → req.auth === { message }
//   - a request @auth/core can't even parse (e.g. a malformed client-supplied
//     `authjs.callback-url` cookie) → `Response.json("Bad request.", { 400 })`
//     → req.auth === "Bad request."
// (both verified against @auth/core@0.41.2 index.js's Auth()).
// Gating on `if (req.auth)` therefore treats an UNAUTHENTICATED attacker whose
// request tripped one of those errors as signed in — the auth gate fails OPEN.
//
// The fix: only a genuine session carries a `user`. An error object/string does
// not. So gate on the presence of `auth.user`, never on `auth` alone.
// ============================================================================

/**
 * True only for a genuine authenticated session — one carrying a `user`.
 * Returns false for every non-session `req.auth` value @auth/core can produce
 * on an error path (null, a `{ message }` config-error object, a `"Bad
 * request."` parse-error string), so the caller fails CLOSED on all of them.
 */
export function isAuthenticatedSession(auth: unknown): boolean {
  return Boolean(
    auth &&
      typeof auth === "object" &&
      "user" in auth &&
      (auth as { user?: unknown }).user,
  );
}
