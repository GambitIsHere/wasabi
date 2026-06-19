// =============================================================================
// EXAMPLE — Wasabi storefront integration middleware (NOT a runnable module).
// =============================================================================
//
// This is an ILLUSTRATIVE `middleware.ts` to drop into a storefront repo (e.g.
// prepaid-mobile-recharge-ai). It imports `next/server`, so it only runs inside
// a Next.js app — you cannot `node`-run this file standalone. Copy it to the
// storefront root as `middleware.ts`, adjust the EXPERIMENTS/theme map, and wire
// the engine import path.
//
// WHAT IT REPLACES — VWO's Split-URL test. VWO used to bucket a visitor and
// physically send them to one of two URLs (control `?theme=tu_lov_uk` vs variant
// `?theme=tu_lov_uk_19`). Wasabi does the bucketing server-side at the edge, then
// rewrites the URL to add the winning `?theme=` slug. The DECISION moves to us;
// everything downstream of `?theme=` is UNCHANGED:
//
//   visitor → [this middleware] decide variant → add ?theme=<slug>
//           → existing theme-resolver.ts parses ?theme=          [UNCHANGED]
//           → /api/applications reads themeSlug (_NN → premium_NN) [UNCHANGED]
//
// The whole point: Wasabi ONLY decides which `?theme=` a visitor gets. The
// theme-resolver and the applications route never learn that Wasabi exists.
//
// GROUNDING — why a URL rewrite (and not just a cookie):
//   - hooks/use-tracking-params.ts `getTheme()` reads `window.location.search`
//     ("urlParams.get('theme')") — it does NOT read any cookie.
//   - app/[locale]/payment/page.tsx reads `searchParams.get("theme")` server-side.
//   So the slug MUST be present as a `?theme=` query param on the URL the
//   storefront renders. A bare theme cookie would be invisible to today's code.
//   The rewrite below puts `?theme=<slug>` on the request the app sees, exactly
//   where the existing pipeline already looks.
// =============================================================================

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ── (A) LOCAL-EVAL imports — the PREFERRED path ───────────────────────────────
// Pull the pure assignment function + types straight from the engine. Assignment
// is a deterministic SHA-1 hash of (experimentKey, distinctId): no network, <1ms,
// and sticky forever for a given distinctId. Vendor these (or add the engine as a
// workspace dep) so the edge bundle stays tiny — `getFeatureFlag` has no Node-only
// deps beyond `node:crypto`, which the Next.js Node runtime provides.
//
// NOTE: in the storefront these would resolve to your vendored copy, e.g.
//   import { getFeatureFlag } from "@/lib/wasabi/assignment";
//   import type { FeatureFlag, ThemeMap } from "@/lib/wasabi/types";
import { getFeatureFlag } from "../engine/src/assignment.ts";
import type { FeatureFlag, ThemeMap } from "../engine/src/types.ts";

// =============================================================================
// CONFIG — the experiment(s) this storefront runs.
// =============================================================================

/** The sticky anonymous-visitor cookie. Becomes `Transaction.customerId` post-signup,
 *  so an assignment made at the edge ties back to the DB row for P&L results. */
const DISTINCT_ID_COOKIE = "wasabi_did";

/** Which experiment governs this storefront's theme. Mirrors the live VWO test. */
const EXPERIMENT_KEY = "tu-billing-uk";

// (A) LOCAL EVAL — the experiment definition lives in the edge bundle. This is the
// SAME shape the engine's store.ts seeds, kept in sync with the Wasabi admin. With
// the def local, assignment is a pure function call — no /decide round-trip.
const EXPERIMENT: FeatureFlag = {
  key: EXPERIMENT_KEY,
  active: true,
  rolloutPercentage: 100, // everyone is in the test
  variants: [
    { key: "control", rolloutPercentage: 50 }, // → tu_lov_uk
    { key: "variant_19", rolloutPercentage: 50 }, // → tu_lov_uk_19
  ],
};

// The integration contract: variant key → storefront `?theme=` slug. The `_19`
// suffix is what app/api/applications/route.ts turns into `premium_19` server-side
// (its regex: `/_(\d{2,})$/`). Control carries the plain UK slug.
const THEME_MAP: ThemeMap = {
  control: "tu_lov_uk",
  variant_19: "tu_lov_uk_19",
};

/** Default slug for visitors NOT in the test (flag `false`) — keeps behaviour
 *  identical to "no experiment running". */
const DEFAULT_THEME = "tu_lov_uk";

// =============================================================================
// Pure mapping: variant value → `?theme=` slug. Exported so it can be unit-tested
// in isolation (no Next.js, no crypto) — see integration/README.md verification.
// =============================================================================

/**
 * Map a flag value (`false` | `true` | "<variant>") to the storefront slug.
 * - `false`  → DEFAULT_THEME (visitor not bucketed into the test).
 * - variant  → its mapped slug, or DEFAULT_THEME if the map has no entry.
 * - `true`   → DEFAULT_THEME (a boolean flag has no variant slug).
 */
export function themeForFlagValue(
  value: boolean | string,
  themeMap: ThemeMap,
  defaultTheme: string,
): string {
  if (typeof value !== "string") return defaultTheme;
  // noUncheckedIndexedAccess: an unmapped variant falls back to the default.
  return themeMap[value] ?? defaultTheme;
}

// =============================================================================
// The middleware.
// =============================================================================

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const url = request.nextUrl;

  // If a `?theme=` is ALREADY on the URL (a campaign deep-link, or a VWO-era
  // bookmarked URL), respect it verbatim and do nothing — never override an
  // explicit slug. This makes adoption safe: existing paid-traffic links win.
  if (url.searchParams.has("theme")) {
    return NextResponse.next();
  }

  // ── (a) Ensure a sticky distinctId ──────────────────────────────────────────
  // Read the visitor's id from the cookie; mint one if absent. This id is the
  // ONLY thing the assignment depends on, so a returning visitor (same cookie)
  // always lands in the same variant — VWO-style stickiness, storage-free.
  const existingId = request.cookies.get(DISTINCT_ID_COOKIE)?.value;
  const distinctId = existingId ?? crypto.randomUUID();

  // ── (b) Decide the variant ──────────────────────────────────────────────────
  // Two modes below. Pick ONE per storefront. (A) is the default.

  // (A) LOCAL EVAL — preferred. Deterministic, no network, <1ms. The experiment
  //     def is bundled above; assignment is a pure hash. This keeps the whole
  //     middleware inside the <30ms edge budget with room to spare.
  const flagValue = getFeatureFlag(EXPERIMENT, distinctId);

  // (B) REMOTE /decide — use this when experiment defs live ONLY in the Wasabi
  //     service (so storefronts don't redeploy to start/stop a test). It costs a
  //     network hop, so keep the engine close to the edge (same region) and set a
  //     tight timeout; fall back to control if it's slow/unreachable. Uncomment to
  //     use instead of (A):
  //
  //   const flagValue = await decideRemote(distinctId);
  //
  // (see decideRemote() at the bottom — it POSTs the /decide wire contract and
  //  reads `themes[EXPERIMENT_KEY]` directly, so it can skip THEME_MAP entirely.)

  // ── (c) Map variant → `?theme=` slug ────────────────────────────────────────
  const themeSlug = themeForFlagValue(flagValue, THEME_MAP, DEFAULT_THEME);

  // ── (d) Apply it so the existing theme-resolver picks it up ──────────────────
  // REWRITE (not redirect): add `?theme=<slug>` to the URL the app renders, WITHOUT
  // changing the address bar. The storefront's page components then read
  // `searchParams.get("theme")` / `getTheme()` exactly as they do for a campaign
  // link — they can't tell Wasabi assigned it. (A redirect would also work but
  // flashes the URL and costs a round-trip; rewrite is invisible and cheaper.)
  const rewritten = url.clone();
  rewritten.searchParams.set("theme", themeSlug);
  const response = NextResponse.rewrite(rewritten);

  // Persist the distinctId so the next request is sticky. httpOnly: the visitor
  // never needs it in JS; it's an attribution/assignment key, not UI state.
  if (existingId === undefined) {
    response.cookies.set(DISTINCT_ID_COOKIE, distinctId, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 60 * 60 * 24 * 365, // 1 year — must outlive the experiment window.
    });
  }

  return response;
}

// =============================================================================
// (B) REMOTE decision — only used if you switch the decide step above to remote.
// Speaks the engine's /decide wire contract (engine/src/wire.ts): POST a
// { distinctId } and read back { featureFlags, themes }. The server already maps
// variant → theme slug, so in remote mode we read `themes[key]` and skip the local
// THEME_MAP. Fails SAFE to control if anything goes wrong — a test must never take
// the storefront down.
// =============================================================================

const WASABI_HOST = process.env.WASABI_HOST ?? "https://wasabi.sanjow.app";

// Inline the slice of the wire contract we need so this example has no runtime
// import from the engine for the remote path (types are erased at build).
interface DecideResponse {
  featureFlags: Record<string, boolean | string>;
  themes: Record<string, string>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- referenced by the
// commented-out (B) branch above; wired in when a storefront opts into remote.
async function decideRemote(distinctId: string): Promise<string> {
  try {
    // Tight timeout: assignment must stay inside the <30ms edge budget. If the
    // engine is slow, we'd rather serve control than block the page.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25);

    const res = await fetch(`${WASABI_HOST}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ distinctId }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return "control";
    const data = (await res.json()) as DecideResponse;

    // The engine already resolved the slug — return the variant key so the SAME
    // themeForFlagValue() mapping applies. (Or read data.themes[EXPERIMENT_KEY]
    // directly and skip THEME_MAP — both are valid; we keep one mapping path here.)
    const value = data.featureFlags[EXPERIMENT_KEY];
    return typeof value === "string" ? value : "control";
  } catch {
    // Network error / abort / bad JSON → fail safe to control.
    return "control";
  }
}

// =============================================================================
// Matcher — run ONLY on the storefront's landing/entry routes, never on assets,
// API routes, or _next internals. Keep this list tight so the middleware adds no
// latency where it can't change anything.
// =============================================================================
export const config = {
  matcher: [
    // All paths except Next internals, the API, and static files.
    "/((?!_next/static|_next/image|favicon.ico|api/).*)",
  ],
};
