// ============================================================================
// Wasabi admin gate — Google + password SSO via Auth.js v5, now multi-tenant.
// ----------------------------------------------------------------------------
// Two independent jobs, both on every request (see the matcher at the bottom):
//   1. TENANT HEADER — parse the Host (+ dev-only ?org=) into a candidate org
//      slug (lib/subdomain.ts, pure, Edge-safe) and forward it via
//      ORG_SLUG_HEADER so server code (lib/org.ts, auth.ts) can look it up
//      against Postgres — which THIS file cannot do; the Neon HTTP driver
//      needs the Node runtime, and middleware is Edge-only. Runs BEFORE the
//      auth check, and unconditionally, so it applies to public AND gated
//      routes alike (e.g. /signin needs to know which org to brand itself
//      against before anyone has signed in).
//
//      HEADER FORGERY: `new Headers(req.headers)` starts as a COPY of the
//      inbound request, which could already contain a caller-supplied
//      ORG_SLUG_HEADER — deleted immediately, unconditionally, before this
//      function sets its own value. Nothing downstream ever sees a client's
//      own copy of this header, only the one middleware computed. See
//      lib/subdomain.ts's header comment for the full trust-boundary story.
//
//   2. AUTH GATE — unchanged in spirit from before this batch: redirect an
//      unauthenticated request to a non-public route to /signin. The
//      per-domain / per-org restriction itself lives in auth.ts's callbacks,
//      not here — this file only decides "is there a session at all".
//
// PUBLIC (no auth, no redirect — tenant header is still forwarded, see above):
//   • /api/decide + /api/capture   — storefronts call these cross-origin
//   • /api/auth/*                  — OAuth + credentials callback handlers (would infinite-loop otherwise)
//   • /api/register                — self-registration (rate-limited inside — see app/api/register/route.ts)
//   • /signin, /register           — the sign-in / sign-up pages themselves
//   • /handover.html               — public CTO handover / install doc
//
// Runs on the Edge runtime.
// ============================================================================
import { NextResponse, type NextRequest } from "next/server";
import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";
import { isAuthenticatedSession } from "@/lib/session-gate";
import { ORG_QUERY_PARAM, ORG_SLUG_HEADER, resolveOrgSlugFromHost } from "@/lib/subdomain";

// ============================================================================
// Boot-time environment guards — fail CLOSED at module load, never per-request.
// A misconfiguration must surface as a boot error (this instance refuses to
// serve), never degrade the gate one request at a time.
// ----------------------------------------------------------------------------
const DEV_NO_AUTH = process.env.WASABI_DEV_NO_AUTH === "1";

// C3 — the dev-only no-auth bypass must NEVER be selectable in a deployed
// environment. Vercel sets `VERCEL=1` on every deploy; a production build sets
// NODE_ENV=production. Either means "not local dev" → refuse to boot with the
// gate disabled rather than serve every gated page + admin API unauthenticated.
if (DEV_NO_AUTH && (process.env.VERCEL || process.env.NODE_ENV === "production")) {
  throw new Error(
    "WASABI_DEV_NO_AUTH=1 is set in a production/Vercel environment. It disables " +
      "the entire SSO gate and is for local dev ONLY (see .env.local.example). Refusing to boot.",
  );
}

// C1 — a missing AUTH_SECRET makes @auth/core return a truthy error body that
// the gate must never mistake for a session (see lib/session-gate.ts). Assert
// it up front so a missing secret is a boot error, not a per-request fail-open.
// Skipped only when the no-auth bypass is active — which C3 above guarantees can
// only be local dev, where the gate never runs.
if (!DEV_NO_AUTH && !process.env.AUTH_SECRET) {
  throw new Error(
    "AUTH_SECRET is not set. Auth.js needs it to verify session JWTs; without it the " +
      "auth gate can fail open. Set AUTH_SECRET (openssl rand -base64 32). Refusing to boot.",
  );
}

// A SEPARATE, Edge-safe NextAuth instance built from auth.config.ts's slim
// base — NOT `import { auth } from "@/auth"`. auth.ts adds the Credentials
// provider, which needs lib/password.ts (a native @node-rs/argon2 binding);
// importing the full auth.ts here would pull that native binding into
// middleware's Edge bundle and fail to build (verified: this was an actual
// bug caught by webpack, not just a theoretical concern — see
// auth.config.ts's header comment for the full reasoning). This instance
// only ever needs `auth()` to decode the existing session cookie for the
// `req.auth` truthiness check below; it never triggers a real sign-in (that
// only happens via app/api/auth/[...nextauth]/route.ts, which uses the FULL
// config), so missing the Credentials provider here has no behavioural
// effect on it.
const { auth } = NextAuth(authConfig);

const PUBLIC_PREFIXES = [
  "/api/decide",
  "/api/capture",
  "/api/auth",
  "/api/register",
  "/signin",
  "/register",
  "/handover.html",
  "/icon.svg", // favicon — must load on the sign-in page / logged-out tabs
  "/apple-icon.png", // iOS home-screen icon — fetchable without auth
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

/**
 * Resolve the org slug for this request and return a rewritten headers bag
 * with ORG_SLUG_HEADER set to it (or absent, if unresolvable) — see this
 * file's header comment on why the inbound copy is always deleted first.
 * Shared by both the real gate and the dev-no-auth bypass below, so tenant
 * resolution never silently depends on which one is active.
 */
function withResolvedOrgHeader(req: NextRequest): Headers {
  const headers = new Headers(req.headers);
  headers.delete(ORG_SLUG_HEADER);

  const host = req.headers.get("host");
  const queryOrg = req.nextUrl.searchParams.get(ORG_QUERY_PARAM);
  const isDev = process.env.USE_LOCAL_PG === "1";
  // VERCEL_ENV gates the *.vercel.app ?org= override off in production (I7).
  const { slug } = resolveOrgSlugFromHost(host, queryOrg, isDev, process.env.VERCEL_ENV);
  if (slug) headers.set(ORG_SLUG_HEADER, slug);

  return headers;
}

const gate = auth((req) => {
  const headers = withResolvedOrgHeader(req);
  const { pathname, search } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next({ request: { headers } });
  // C1 — gate on the REAL session shape (`auth.user`), never on `req.auth`
  // alone: an @auth/core error body is truthy but carries no user, and treating
  // it as signed in fails the gate OPEN. See lib/session-gate.ts.
  if (isAuthenticatedSession(req.auth)) {
    return NextResponse.next({ request: { headers } }); // signed in → continue, tenant header still forwarded
  }

  // Anything without a valid user (unauthenticated, OR a truthy @auth/core error
  // body) fails CLOSED → /signin. Never next().
  const signInUrl = new URL("/signin", req.nextUrl.origin);
  signInUrl.searchParams.set("callbackUrl", pathname + search);
  return Response.redirect(signInUrl);
});

/** Dev-only escape hatch: WASABI_DEV_NO_AUTH=1 skips the SSO gate so the app
 *  can run against a local Postgres without Google sign-in. Still resolves +
 *  forwards the tenant header (see withResolvedOrgHeader) — skipping AUTH
 *  must never also skip TENANCY, or every local page would silently render
 *  as "unknown workspace" regardless of host. NEVER set in production. */
function devNoAuthGate(req: NextRequest): NextResponse {
  return NextResponse.next({ request: { headers: withResolvedOrgHeader(req) } });
}

export default DEV_NO_AUTH ? devNoAuthGate : gate;

// Run on every route except Next internals + static assets. The public-prefix
// check inside handles /api/decide + /api/capture + /api/auth + /api/register
// + /signin + /register.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
