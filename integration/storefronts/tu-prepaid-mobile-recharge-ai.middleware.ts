// ============================================================================
// Wasabi middleware — TU (prepaid-mobile-recharge-ai)
// ----------------------------------------------------------------------------
// READY TO APPLY: copy to the repo ROOT as `middleware.ts`, set WASABI_URL in env,
// then TEST (see integration/storefronts/README.md). This repo has no existing
// middleware, so it's a clean new file — AC/AS instead MERGE into an existing
// next-intl middleware.
//
// WHY redirect-then-rewrite (not a plain rewrite):
//   The storefront reads ?theme= BOTH server-side (searchParams) AND client-side
//   (`getTheme()` → window.location.search → sessionStorage). A plain rewrite only
//   feeds the server — the browser URL is unchanged, so client-side getTheme()
//   would miss it. So on FIRST assignment we 307-redirect to ?theme=<slug> (lands
//   in the real URL → client stores it), remember the slug in a cookie, and on
//   later requests rewrite-from-cookie to keep the server in sync WITHOUT another
//   redirect. Exactly one redirect per visitor per experiment.
//
// Assignment comes from the Wasabi service (POST /api/decide) — single source of
// truth, FAIL-SAFE to control on timeout/error. Toggle the test in the Wasabi
// admin; no redeploy here.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";

/** The experiment this storefront runs. Toggle/retarget it in the Wasabi admin. */
const EXPERIMENT_KEY = "tu-billing-uk";

const WASABI_URL = (process.env.WASABI_URL ?? "").replace(/\/$/, "");
const DID_COOKIE = "wasabi_did";
const THEME_COOKIE = `wasabi_${EXPERIMENT_KEY}`; // remembers the decided slug
const YEAR = 60 * 60 * 24 * 365;
const ASSIGN_MAX_AGE = 60 * 60 * 24 * 30; // 30d — the experiment's sticky window
const DECIDE_TIMEOUT_MS = 25;

/** Ask Wasabi for this visitor's slug for EXPERIMENT_KEY. Fails safe to null. */
async function decideSlug(did: string): Promise<string | null> {
  if (!WASABI_URL) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DECIDE_TIMEOUT_MS);
  try {
    const res = await fetch(`${WASABI_URL}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ distinctId: did }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { themes?: Record<string, string> };
    return data.themes?.[EXPERIMENT_KEY] ?? null;
  } catch {
    return null; // timeout / network / parse → control
  } finally {
    clearTimeout(timer);
  }
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const existingDid = request.cookies.get(DID_COOKIE)?.value;
  const did = existingDid ?? crypto.randomUUID();
  const url = request.nextUrl;

  let response: NextResponse;

  if (url.searchParams.has("theme")) {
    // Already themed (campaign deep-link, or the redirect below). Remember it and
    // stop deciding for this visitor — never override an explicit theme.
    response = NextResponse.next();
    response.cookies.set(THEME_COOKIE, url.searchParams.get("theme")!, {
      path: "/", sameSite: "lax", maxAge: ASSIGN_MAX_AGE,
    });
  } else {
    const remembered = request.cookies.get(THEME_COOKIE)?.value;
    if (remembered) {
      // Keep the SERVER in sync on later requests (client already has it from the
      // first themed load) — rewrite, no redirect, no extra round-trip.
      const rw = url.clone();
      rw.searchParams.set("theme", remembered);
      response = NextResponse.rewrite(rw);
    } else {
      // First touch → assign.
      const slug = await decideSlug(did);
      if (slug) {
        const target = url.clone();
        target.searchParams.set("theme", slug);
        response = NextResponse.redirect(target, 307); // lands in the real URL
        response.cookies.set(THEME_COOKIE, slug, {
          path: "/", sameSite: "lax", maxAge: ASSIGN_MAX_AGE,
        });
      } else {
        response = NextResponse.next(); // unassigned / fail-safe → control
      }
    }
  }

  // Sticky anonymous id (httpOnly — it's an assignment/attribution key, not UI
  // state; thread it to customerId at signup later, see README).
  if (!existingDid) {
    response.cookies.set(DID_COOKIE, did, {
      path: "/", httpOnly: true, sameSite: "lax", maxAge: YEAR,
    });
  }
  return response;
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
