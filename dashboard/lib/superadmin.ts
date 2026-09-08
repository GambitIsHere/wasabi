// ============================================================================
// lib/superadmin.ts — the CROSS-ORG super-admin gate for the Sanjow operator
// console (app/operator/*).
// ----------------------------------------------------------------------------
// This is deliberately NOT lib/authz.ts's requireRole(). requireRole is
// PER-ORG: it authorizes "does the caller hold role X in THEIR OWN org" and
// resolves that org from the session/subdomain — so a normal org owner passes
// it for their own tenant. The operator console reads EVERY tenant's data, so
// reusing requireRole would let any org owner see other orgs. requireSuperAdmin
// answers a different, platform-level question: "is this caller a Sanjow
// PLATFORM operator, allowed to see across all orgs?"
//
// GATE (fail closed, re-derived from the DB — never the JWT):
//   0. Local-dev bypass — identical guard to lib/authz.ts / middleware.ts
//      (WASABI_DEV_NO_AUTH=1, and not Vercel/production). middleware.ts throws
//      at boot if that flag is ever set in a deployed environment, so this
//      branch can only grant access on a developer's own machine.
//   1. A signed-in session with an email, or 401.
//   2. A live `user` row that is status = "active", or 403 (a suspended or
//      pending account is refused the instant it flips, not when its 30-day
//      JWT expires — same posture as requireRole's status re-check).
//   3. Authorization, by whichever signal is configured:
//      a. If WASABI_SUPERADMIN_EMAILS is set (non-empty), it is AUTHORITATIVE:
//         the caller's email must be on that explicit operator allowlist. The
//         membership fallback is NOT consulted — an allowlist is the tightest,
//         most explicit control, so when present it is the whole gate.
//      b. If it is unset, fall back to an active owner/admin membership of the
//         SANJOW org SPECIFICALLY (SANJOW_ORG_ID, a fixed constant — never the
//         request's resolved org). A different org's owner has no membership
//         row in SANJOW_ORG_ID, so getMembership returns null and they are
//         refused. This path does NOT lazily provision a membership the way
//         requireRole does — platform access must be granted, never bootstrapped.
//
// FLAGGED FOR REVIEW: the chosen default (no env) is "active owner/admin of the
// Sanjow org". That is safe because SANJOW_ORG_ID is fixed and membership is
// re-read live, but a deployment that wants a tighter operator set than
// "everyone who can administer the Sanjow tenant" should set
// WASABI_SUPERADMIN_EMAILS. See .env.example.
// ============================================================================
import { auth } from "@/auth";
import { getMembership } from "@/lib/membership";
import { roleAtLeast } from "@/lib/roles";
import { SANJOW_ORG_ID } from "@/lib/tenant";
import { findUserByEmail } from "@/lib/users";

/** How the caller cleared the gate — useful for an audit line, never a
 *  privilege signal (every value means "authorized"). */
export type SuperAdminGrant = "dev-bypass" | "allowlist" | "sanjow-admin";

export type SuperAdminResult =
  | { ok: true; userId: string; email: string; via: SuperAdminGrant }
  | { ok: false; status: 401 | 403; error: string };

/** Generic, non-leaky denial — never says WHICH check failed, matching
 *  lib/authz.ts's anti-enumeration posture. */
const FORBIDDEN: SuperAdminResult = {
  ok: false,
  status: 403,
  error: "This area is restricted to Sanjow platform operators.",
};

const ALLOWLIST_ENV = "WASABI_SUPERADMIN_EMAILS";

/** Split the allowlist env into normalised (trimmed, lowercased) emails.
 *  Accepts commas and/or whitespace as separators; drops blanks. Pure — no
 *  environment or DB access — so it is unit-tested directly. */
export function parseSuperAdminAllowlist(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** True when `email` is on the allowlist parsed from `raw`. An empty/unset
 *  allowlist is never a match (the caller decides the fallback). Pure. */
export function isEmailAllowlisted(email: string, raw: string | undefined | null): boolean {
  const list = parseSuperAdminAllowlist(raw);
  if (list.length === 0) return false;
  return list.includes(email.trim().toLowerCase());
}

/** The local-dev SSO bypass — the SAME triple guard middleware.ts enforces at
 *  boot (so it can never be true in a Vercel/production environment). */
function devBypassActive(): boolean {
  return (
    process.env.WASABI_DEV_NO_AUTH === "1" &&
    !process.env.VERCEL &&
    process.env.NODE_ENV !== "production"
  );
}

/**
 * Authorize the current request as a Sanjow platform operator. See this file's
 * header for the full gate. Callers (app/operator/*) MUST run this BEFORE
 * fetching or rendering any cross-org data, and render nothing but the refusal
 * on `{ ok:false }` — the whole safety property is "an unauthorized caller
 * never triggers a cross-tenant read".
 */
export async function requireSuperAdmin(): Promise<SuperAdminResult> {
  if (devBypassActive()) {
    return { ok: true, userId: "dev-no-auth", email: "dev@localhost", via: "dev-bypass" };
  }

  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return { ok: false, status: 401, error: "You must be signed in." };
  }

  const dbUser = await findUserByEmail(email);
  if (!dbUser) return FORBIDDEN;
  if (dbUser.status !== "active") return FORBIDDEN;

  const allowlist = parseSuperAdminAllowlist(process.env[ALLOWLIST_ENV]);
  if (allowlist.length > 0) {
    // Explicit operator allowlist configured → it is the whole gate.
    if (allowlist.includes(dbUser.email)) {
      return { ok: true, userId: dbUser.id, email: dbUser.email, via: "allowlist" };
    }
    return FORBIDDEN;
  }

  // No allowlist configured → fall back to an active owner/admin of the Sanjow
  // org specifically. Never the request's resolved org, never lazily provisioned.
  const membership = await getMembership(dbUser.id, SANJOW_ORG_ID);
  if (membership && roleAtLeast(membership.role, "admin")) {
    return { ok: true, userId: dbUser.id, email: dbUser.email, via: "sanjow-admin" };
  }
  return FORBIDDEN;
}
