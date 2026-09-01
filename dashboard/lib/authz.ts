// ============================================================================
// lib/authz.ts — role-gate for mutating admin routes + server actions.
// ----------------------------------------------------------------------------
// The authentication gate (middleware.ts) only proves "there is a session".
// This adds AUTHORIZATION — "does the caller hold at least role X in their org"
// — re-derived from the `membership` table on EVERY call, never trusted from the
// JWT alone. The session's role/orgId are baked in at sign-in and cached for the
// life of the 30-day token (see auth.config.ts's jwt callback), so a demoted,
// suspended, or removed member keeps their old claims until it expires. Every
// destructive verb therefore re-reads the caller's live `user.status` +
// `membership` here — which is also the concrete fix, for the dangerous paths,
// of "suspension/removal/demotion don't take effect until the JWT expires".
//
// MIGRATION SAFETY (the live-Sanjow transition — read before changing this):
// the current deployment has active sessions minted before roles/orgs existed
// (no session.orgId / session.role) AND users with no `membership` row yet
// (rows are created at sign-in; scripts/migrate-tenancy.ts back-filled the
// org/project but deliberately not memberships). Failing closed on "no
// membership row" would lock every current admin out of the tool — with no
// owner left who could grant anyone a role. So when a caller has a valid,
// ACTIVE session whose email matches the org's verified domain but no membership
// yet, we LAZILY PROVISION one using the exact rule sign-in already uses
// (lib/membership.determineRoleForNewMembership: the first member of the org
// becomes owner, everyone after defaults to viewer). That is precisely what
// their next sign-in would create anyway — we just do it on their first
// authorized action instead of waiting for a re-login. Fails closed everywhere
// it should: a suspended/pending account, an email off the verified domain, an
// unresolvable org, or a genuine `viewer` whose membership already exists are
// all denied.
// ============================================================================
import { auth } from "@/auth";
import { emailMatchesDomain } from "@/lib/domain-restriction";
import {
  determineRoleForNewMembership,
  findOrCreateMembership,
  getMembership,
} from "@/lib/membership";
import { getOrgById } from "@/lib/org";
import { roleAtLeast, type MembershipRole } from "@/lib/roles";
import { getCurrentOrgId, SANJOW_ORG_ID } from "@/lib/tenant";
import { findUserByEmail } from "@/lib/users";

export type RequireRoleResult =
  | { ok: true; userId: string; orgId: string; role: MembershipRole }
  | { ok: false; status: 401 | 403; error: string };

/** Generic, non-leaky denial — never says WHICH check failed (no such user vs
 *  suspended vs role-too-low), same anti-enumeration posture as the login gate. */
const FORBIDDEN: RequireRoleResult = {
  ok: false,
  status: 403,
  error: "You don't have permission to perform this action.",
};

/**
 * Authorize the current request for at least `minimum` role in the caller's
 * org, re-deriving everything from the database (never the JWT). Returns a
 * discriminated result so the caller decides the transport — a route maps
 * `{ ok:false }` to `NextResponse.json({...}, { status })`, a server action to
 * its own `{ ok:false, error }` shape.
 *
 * Callers MUST run this BEFORE any side effect or any read they don't want an
 * unauthorized caller to trigger (e.g. attach-payment must gate before it hits
 * Metabase). See this file's header for the migration-safety behaviour.
 */
export async function requireRole(minimum: MembershipRole): Promise<RequireRoleResult> {
  // Local dev bypass — mirrors middleware.ts's WASABI_DEV_NO_AUTH gate bypass so
  // the authN gate and this authZ gate never disagree. When the SSO gate is
  // skipped for local dev there's no session to derive a role from, so authorize
  // as owner. Guarded to local dev the SAME way middleware.ts is — it throws at
  // boot if WASABI_DEV_NO_AUTH is ever "1" with VERCEL set or NODE_ENV=production
  // — so this branch can never grant access in a deployed environment.
  if (
    process.env.WASABI_DEV_NO_AUTH === "1" &&
    !process.env.VERCEL &&
    process.env.NODE_ENV !== "production"
  ) {
    return { ok: true, userId: "dev-no-auth", orgId: SANJOW_ORG_ID, role: "owner" };
  }

  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    // Behind the middleware gate this should be unreachable, but authorize
    // independently rather than assume the gate ran (defence in depth).
    return { ok: false, status: 401, error: "You must be signed in." };
  }

  // Which org's membership to check. Trust the session's org when present;
  // otherwise (a pre-migration token with no orgId) resolve it the same way
  // every other request does — via the subdomain — rather than guessing.
  let orgId = session.orgId;
  if (!orgId) {
    try {
      orgId = await getCurrentOrgId();
    } catch {
      return FORBIDDEN;
    }
  }

  const dbUser = await findUserByEmail(email);
  if (!dbUser) return FORBIDDEN;
  // Live status re-check: a suspended (or still-pending) account is refused the
  // instant it is flipped, not 30 days later when the token finally expires.
  if (dbUser.status !== "active") return FORBIDDEN;

  let membership = await getMembership(dbUser.id, orgId);
  if (!membership) {
    // No membership row yet — the live-Sanjow transition (see header). Provision
    // one lazily, but only for a session whose email genuinely belongs to the
    // org's verified domain, and at the same role sign-in would assign.
    const org = await getOrgById(orgId);
    if (!org) return FORBIDDEN;
    const allowedDomain = org.verifiedDomain ?? process.env.AUTH_ALLOWED_EMAIL_DOMAIN;
    if (!allowedDomain || !emailMatchesDomain(dbUser.email, allowedDomain)) {
      return FORBIDDEN;
    }
    // dbUser is active (re-checked above), so this can bootstrap the org to
    // owner for its first active member — the live-Sanjow transition (I13's
    // active-only rule applies equally here).
    const role = await determineRoleForNewMembership(orgId, true);
    membership = await findOrCreateMembership(dbUser.id, orgId, role);
  }

  if (!roleAtLeast(membership.role, minimum)) return FORBIDDEN;
  return { ok: true, userId: dbUser.id, orgId, role: membership.role };
}
