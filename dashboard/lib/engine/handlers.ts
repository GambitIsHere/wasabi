// Pure request handlers — the engine's business logic with NO transport
// concerns (no sockets, no Next.js Request/Response). The route handlers parse
// the request into these typed inputs and serialise the typed outputs back, so
// every handler here is a plain function you can unit-test with a literal object.
//
// Ported from engine/src/api.ts; reads the experiment registry from
// lib/experiments.ts (which carries both the live flag split and theme maps).
import { getFeatureFlag } from "./assignment";
import { getExperimentFlags, getThemeMap } from "../experiments";
import type {
  CaptureRequest,
  CaptureResponse,
  DecideRequest,
  DecideResponse,
  FlagsResponse,
} from "./wire";

/**
 * POST /decide — resolve every registered experiment for one user.
 *
 * `featureFlags` always carries the raw value (false / true / variant key) for
 * every flag, so callers can see "not in this test" explicitly. `themes` is the
 * Sanjow convenience layer: experiment key → storefront `?theme=` slug, added
 * only when the user is actually in a variant that has a slug.
 */
export function handleDecide(req: DecideRequest): DecideResponse {
  const featureFlags: DecideResponse["featureFlags"] = {};
  const themes: DecideResponse["themes"] = {};

  for (const flag of getExperimentFlags()) {
    const value = getFeatureFlag(flag, req.distinctId);
    featureFlags[flag.key] = value;

    // Only string values (variant keys) can carry a theme slug.
    if (typeof value === "string") {
      const slug = getThemeMap(flag.key)?.[value];
      if (slug !== undefined) themes[flag.key] = slug;
    }
  }

  return { featureFlags, themes };
}

// In-memory event log — fine for the spike. Resets per server process.
const capturedEvents: CaptureRequest[] = [];

/**
 * POST /capture — record one event for a user. Stamps `timestamp` server-side
 * when omitted, logs it, and returns PostHog's `{ status: 1 }` ack. Never
 * rejects a well-formed event — capture must be cheap and lossless.
 */
export function handleCapture(req: CaptureRequest): CaptureResponse {
  const event: CaptureRequest = {
    ...req,
    timestamp: req.timestamp ?? new Date().toISOString(),
  };
  capturedEvents.push(event);
  console.log(
    `[capture] ${event.timestamp} ${event.distinctId} → ${event.event}`,
    event.properties ?? {},
  );
  return { status: 1 };
}

/** All events captured this process lifetime — for the demo/admin to inspect. */
export function getCapturedEvents(): readonly CaptureRequest[] {
  return capturedEvents;
}

/**
 * GET /flags — list active experiments for debug/admin. Surfaces variant *keys*
 * only (not percentages) — a quick "what's running" view, not the assignment
 * payload.
 */
export function handleFlags(): FlagsResponse {
  return {
    flags: getExperimentFlags().map((flag) => ({
      key: flag.key,
      active: flag.active,
      variants: (flag.variants ?? []).map((v) => v.key),
    })),
  };
}
