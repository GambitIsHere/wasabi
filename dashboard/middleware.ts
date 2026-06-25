// ============================================================================
// Wasabi admin gate — Google SSO via Auth.js v5.
// ----------------------------------------------------------------------------
// Wraps every route except the public ones (storefront APIs and the sign-in
// surface itself) with NextAuth's `auth` middleware. Unauthenticated requests
// to gated routes are redirected to /signin with a callbackUrl so they bounce
// back after sign-in. The signIn callback in auth.ts enforces the @sanjow.com
// domain restriction.
//
// PUBLIC (no auth, no redirect):
//   • /api/decide + /api/capture   — storefronts call these cross-origin
//   • /api/auth/*                  — OAuth callback handlers (would infinite-loop otherwise)
//   • /signin                      — the sign-in page itself
//
// Runs on the Edge runtime.
// ============================================================================
import { auth } from "@/auth";

const PUBLIC_PREFIXES = ["/api/decide", "/api/capture", "/api/auth", "/signin"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

export default auth((req) => {
  const { pathname, search } = req.nextUrl;
  if (isPublic(pathname)) return;
  if (req.auth) return; // signed in → continue

  const signInUrl = new URL("/signin", req.nextUrl.origin);
  signInUrl.searchParams.set("callbackUrl", pathname + search);
  return Response.redirect(signInUrl);
});

// Run on every route except Next internals + static assets. The public-prefix
// check inside handles /api/decide + /api/capture + /api/auth + /signin.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
