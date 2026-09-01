// ============================================================================
// session-gate.ts — C1: the auth gate must FAIL CLOSED on every non-session
// value @auth/core can hand back as `req.auth`, and only allow a real session.
// ----------------------------------------------------------------------------
// The historical fail-open was `if (req.auth) allow`. next-auth assigns
// `req.auth = await getSession(...).json()` with no status check, so on an
// @auth/core error path req.auth is a truthy NON-session body. These cases
// mirror the exact shapes verified against next-auth@5.0.0-beta.31 +
// @auth/core@0.41.2 (see lib/session-gate.ts's header): a `{ message }`
// config-error object (500, e.g. missing AUTH_SECRET) and a `"Bad request."`
// parse-error string (400, e.g. a malformed authjs.callback-url cookie).
// ============================================================================
import { describe, expect, it } from "vitest";
import { isAuthenticatedSession } from "@/lib/session-gate";

describe("isAuthenticatedSession — fails closed on every non-session req.auth", () => {
  it("null (no session cookie) → not authenticated", () => {
    expect(isAuthenticatedSession(null)).toBe(false);
  });

  it("undefined → not authenticated", () => {
    expect(isAuthenticatedSession(undefined)).toBe(false);
  });

  it("🔴 a { message } config-error body (500, e.g. missing AUTH_SECRET) → not authenticated", () => {
    // The old `if (req.auth)` treated this truthy object as signed in.
    expect(
      isAuthenticatedSession({
        message: "There was a problem with the server configuration.",
      }),
    ).toBe(false);
  });

  it("🔴 a \"Bad request.\" parse-error body (400, e.g. a malformed callback-url cookie) → not authenticated", () => {
    expect(isAuthenticatedSession("Bad request.")).toBe(false);
  });

  it("an object whose user is null/absent → not authenticated", () => {
    expect(isAuthenticatedSession({ expires: "2026-01-01T00:00:00.000Z" })).toBe(false);
    expect(isAuthenticatedSession({ user: null })).toBe(false);
    expect(isAuthenticatedSession({ user: undefined })).toBe(false);
  });
});

describe("isAuthenticatedSession — allows a genuine session", () => {
  it("a session carrying a user → authenticated", () => {
    expect(
      isAuthenticatedSession({
        user: { email: "alice@sanjow.com", name: "Alice" },
        expires: "2026-01-01T00:00:00.000Z",
        orgId: "sanjow",
        role: "owner",
      }),
    ).toBe(true);
  });
});
