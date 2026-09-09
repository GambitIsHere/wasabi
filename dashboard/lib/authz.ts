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
 * The synthetic caller id `requireRole` returns from the local-dev
 * `WASABI_DEV_NO_AUTH` bypass when there is NO real session to attribute to.
 * It is NOT a row in the `user` table, so any Server Action that writes
 * `gate.userId` into a column with a foreign key to `user(id)` MUST special-case
 * it (fall soft to `null` on a nullable column, say) rather than pass it
 * through — otherwise Postgres rejects the write with a foreign-key violation.
 * Compare against THIS constant, never a bare `"dev-no-auth"` string literal.
 * Only ever appears in local dev — the bypass that produces it refuses to boot
 * in a deployed environment (see middleware.ts's WASABI_DEV_NO_AUTH guard).
 */
export const DEV_NO_AUTH_USER_ID = "dev-no-auth";

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
  // Resolve the live session ONCE, up front: both the local-dev bypass below and
  // the real authorization path need it. auth() returns null when there's no
  // session, and is safe to call in local dev — Auth.js is always initialized,
  // even with the gate bypassed (AUTH_SECRET is required regardless — see
  // LOCAL-DEV.md).
  const session = await auth();
  const email = session?.user?.email;

  // Local dev bypass — mirrors middleware.ts's WASABI_DEV_NO_AUTH gate bypass so
  // the authN gate and this authZ gate never disagree. Guarded to local dev the
  // SAME way middleware.ts is — it throws at boot if WASABI_DEV_NO_AUTH is ever
  // "1" with VERCEL set or NODE_ENV=production — so this branch can never grant
  // access in a deployed environment.
  //
  // Skipping the SSO gate usually means there's no session to derive a role
  // from, so we synthesize an owner grant. But a developer who registered and
  // bootstrapped a REAL account locally (see LOCAL-DEV.md) still has a session
  // even with the flag on — prefer it, and fall through to the normal
  // DB-derived path below so the write attributes to their real `user.id` row.
  // DEV_NO_AUTH_USER_ID has no `user` row and breaks any foreign key to
  // `user(id)`, so fall back to it ONLY when there is genuinely no session.
  if (
    process.env.WASABI_DEV_NO_AUTH === "1" &&
    !process.env.VERCEL &&
    process.env.NODE_ENV !== "production"
  ) {
    if (!email) {
      return { ok: true, userId: DEV_NO_AUTH_USER_ID, orgId: SANJOW_ORG_ID, role: "owner" };
    }
    // A real local session exists — fall through and authorize it as itself.
  }

  if (!email) {
    // Behind the middleware gate this should be unreachable, but authorize
    // independently rather than assume the gate ran (defence in depth).
    return { ok: false, status: 401, error: "You must be signed in." };
  }

  // Which org's membership to check. Resolve it through the SAME host-switch-
  // aware path the data layer uses (getCurrentOrgId → resolveTenantOrgId in
  // lib/tenant.ts), never the raw session.orgId. This keeps authorization and
  // data on the same org: for a user who belongs BOTH to their session org and
  // to the org the Host names, the page they see AND the mutations they run
  // (invite / approve / revoke, all keyed on the returned orgId) resolve to the
  // host org — not, as before, reads to the host org while writes silently
  // landed in the session org. The membership re-check below still gates it:
  // getCurrentOrgId only switches to the host org for a member of it, and this
  // function independently confirms membership in whatever org it returns, so a
  // mutation can never land in an org the caller isn't a member of — and a user
  // acts with their role IN the org they're viewing (an owner of A who is only a
  // viewer of B can't use A's privileges while on B's host). A pre-migration
  // token with no session.orgId still resolves via the subdomain here
  // (getCurrentOrgId's own fallback) rather than failing.
  let orgId: string;
  try {
    // Pass the session we already resolved above so getCurrentOrgId ->
    // resolveTenantOrgId does NOT call auth() a second time for this request
    // (#30: one session resolve per authorized call, not two).
    orgId = await getCurrentOrgId(session);
  } catch {
    return FORBIDDEN;
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
    // #28 (security): lazy provisioning — the owner-bootstrap below included —
    // requires a REAL per-org verified_domain. The old
    // `?? process.env.AUTH_ALLOWED_EMAIL_DOMAIN` fallback was dropped: on a
    // domain-less org, while the global env domain was still set in prod, any
    // active user matching that global domain could visit the org's subdomain
    // and be provisioned here — bootstrapped to OWNER if they were the first
    // active member (owner-claim). We never bootstrap an owner off the global
    // env domain now. This mirrors app/api/register/route.ts, which already
    // refuses when verifiedDomain is falsy and has no env fallback. An org with
    // no verified_domain simply gets no lazy provisioning (owner OR member) —
    // an admin must add its members explicitly (invite / approve).
    const allowedDomain = org.verifiedDomain;
    if (!allowedDomain || !emailMatchesDomain(dbUser.email, allowedDomain)) {
      return FORBIDDEN;
    }
    // dbUser is active (re-checked above), so this can bootstrap the org to
    // owner for its first active member — the live-Sanjow transition (I13's
    // active-only rule applies equally here). Safe now that a real
    // verified_domain (not the global env) is the gate above.
    const role = await determineRoleForNewMembership(orgId, true);
    membership = await findOrCreateMembership(dbUser.id, orgId, role);
  }

  if (!roleAtLeast(membership.role, minimum)) return FORBIDDEN;
  return { ok: true, userId: dbUser.id, orgId, role: membership.role };
}
