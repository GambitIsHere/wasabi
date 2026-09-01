// Pure request handlers — the engine's business logic with NO transport concerns
// (no sockets, no Next.js Request/Response). The route handlers parse the request
// into these typed inputs and serialise the typed outputs back.
//
// Reads the experiment registry from lib/experiments.ts (live flag split + theme
// maps). That registry is Postgres-backed (async). The ASSIGNMENT hot path
// (/decide, /flags) runs on every storefront request, so it reads through a
// short per-instance cache to avoid a Neon round-trip per call.
import { getFeatureFlag } from "./assignment";
import { getExperiments } from "../experiments";
import type { RegisteredExperiment } from "../experiments";
import type {
  CaptureRequest,
  CaptureResponse,
  DecideRequest,
  DecideResponse,
  FlagsResponse,
} from "./wire";

// ---------------------------------------------------------------------------
// Assignment registry cache (hot path only).
// ---------------------------------------------------------------------------
// /decide + /flags are public and called on every storefront request, so we
// cache the registry per serverless instance for a few seconds — assignment
// tolerates slight staleness, and this turns most requests into zero DB
// round-trips. Admin pages/actions read the store UNCACHED (getExperiments /
// listExperiments), so create/edit/activate still reflect immediately.
const REGISTRY_TTL_MS = 10_000;
let registryCache: { exps: RegisteredExperiment[]; expiry: number } | null = null;

async function assignmentRegistry(): Promise<RegisteredExperiment[]> {
  const now = Date.now();
  if (registryCache && registryCache.expiry > now) return registryCache.exps;
  const exps = await getExperiments();
  registryCache = { exps, expiry: now + REGISTRY_TTL_MS };
  return exps;
}

/**
 * POST /decide — resolve every registered experiment for one user.
 *
 * `featureFlags` always carries the raw value (false / true / variant key) for
 * every flag, so callers can see "not in this test" explicitly. `themes` is the
 * Sanjow convenience layer: experiment key → storefront `?theme=` slug, added
 * only when the user is actually in a variant that has a slug.
 */
export async function handleDecide(req: DecideRequest): Promise<DecideResponse> {
  const featureFlags: DecideResponse["featureFlags"] = {};
  const themes: DecideResponse["themes"] = {};

  for (const exp of await assignmentRegistry()) {
    const value = getFeatureFlag(exp.flag, req.distinctId);
    featureFlags[exp.flag.key] = value;

    // Only string values (variant keys) can carry a theme slug.
    if (typeof value === "string") {
      const slug = exp.themeMap[value];
      if (slug !== undefined) themes[exp.flag.key] = slug;
    }
  }

  return { featureFlags, themes };
}

/**
 * POST /capture — accepts a PostHog-shaped event and acks `{ status: 1 }`.
 *
 * This function itself stays transport-agnostic and side-effect-free (log +
 * ack) — the actual persistence lives one layer up, in the route handler
 * (app/api/capture/route.ts), which calls this and then writes one row to the
 * `event` table via lib/events.ts (fail-open: a DB hiccup never fails the
 * caller's ack). That table is the ASSIGNMENT side of the live cockpit feed —
 * who landed in which arm, and when. Experiment RESULTS (auth / rebill /
 * revenue) still come from the global-api payment DB via Metabase, keyed by
 * theme slug, never from these events.
 *
 * The route is PUBLIC and CORS-permissive (storefronts call it cross-origin),
 * so it is gated there rather than here: an optional shared-secret key
 * (WASABI_INGEST_KEY / `x-wasabi-key`) and a per-IP token-bucket rate limit
 * (~60 events/minute/IP) apply before this function is ever called. See the
 * route file for both.
 */
export function handleCapture(req: CaptureRequest): CaptureResponse {
  const timestamp = req.timestamp ?? new Date().toISOString();
  console.log(
    `[capture] ${timestamp} ${req.distinctId} → ${req.event}`,
    req.properties ?? {},
  );
  return { status: 1 };
}

/**
 * GET /flags — list active experiments for debug/admin. Surfaces variant *keys*
 * only (not percentages) — a quick "what's running" view, not the assignment
 * payload. Served from the same hot-path cache as /decide.
 */
export async function handleFlags(): Promise<FlagsResponse> {
  return {
    flags: (await assignmentRegistry()).map((exp) => ({
      key: exp.flag.key,
      active: exp.flag.active,
      variants: (exp.flag.variants ?? []).map((v) => v.key),
    })),
  };
}
