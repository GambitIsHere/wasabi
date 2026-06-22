// ============================================================================
// Wasabi admin gate — the in-app replacement for what Caddy did on the VPS.
// ----------------------------------------------------------------------------
// On Vercel there's no Caddy, and Vercel's Deployment Protection is project-wide
// (it would also block the public API). So we do the split here:
//
//   • PUBLIC (no auth): /api/decide + /api/capture — storefronts call these
//     cross-origin and must NOT be gated.
//   • PROTECTED (HTTP basic-auth): everything else — the admin UI, /api/flags,
//     /api/experiments, results. Credentials come from env.
//
// Set in Vercel (and turn OFF Vercel Deployment Protection so storefronts can
// reach the public API):
//   WASABI_ADMIN_USER      (optional, default "admin")
//   WASABI_ADMIN_PASSWORD  (required to unlock the admin — until set, the admin
//                           is FAIL-CLOSED: locked, while the public API stays up)
//
// Runs on the Edge runtime: Web APIs only (atob, no Buffer/node:crypto).
// ============================================================================
import { NextRequest, NextResponse } from "next/server";

// Public, un-authenticated API surface (storefront assignment + capture).
const PUBLIC_PREFIXES = ["/api/decide", "/api/capture"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

/** Constant-time string compare (avoid leaking length/contents via timing). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Wasabi admin", charset="UTF-8"' },
  });
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // Storefront-facing endpoints are always open.
  if (isPublic(pathname)) return NextResponse.next();

  const expectedUser = process.env.WASABI_ADMIN_USER || "admin";
  const expectedPass = process.env.WASABI_ADMIN_PASSWORD || "";

  // No password configured → fail closed (admin locked), so turning off Vercel's
  // Deployment Protection can never silently expose the admin. The public API
  // above is unaffected.
  if (expectedPass === "") return unauthorized();

  const header = request.headers.get("authorization");
  if (header && header.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = atob(header.slice(6).trim());
    } catch {
      return unauthorized();
    }
    const sep = decoded.indexOf(":");
    if (sep !== -1) {
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      if (safeEqual(user, expectedUser) && safeEqual(pass, expectedPass)) {
        return NextResponse.next();
      }
    }
  }
  return unauthorized();
}

// Run on every route except Next internals + static assets. The public-API check
// inside handles /api/decide + /api/capture.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
