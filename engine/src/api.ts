// Pure request handlers — the engine's business logic with NO transport
// concerns (no `node:http`, no sockets). The server layer (server.ts) parses
// bytes into these typed requests and serialises the typed responses back;
// keeping this file transport-free means every handler is a plain function you
// can unit-test by calling it with a literal object.
import { getFeatureFlag } from "./assignment.ts";
import { getExperiments, getThemeMap } from "./store.ts";
import type {
  CaptureRequest,
  CaptureResponse,
  DecideRequest,
  DecideResponse,
  FlagsResponse,
} from "./wire.ts";

/**
 * POST /decide — resolve every registered experiment for one user.
 *
 * For each experiment we run the PostHog-compatible assignment. `featureFlags`
 * always carries the raw value (false / true / variant key) for every flag, so
 * callers can see "not in this test" explicitly. `themes` is the Sanjow
 * convenience layer: it maps experiment key → storefront `?theme=` slug, and we
 * only add an entry when the user is actually in a variant that has a slug —
 * a user who got `false` (or whose variant has no theme) routes to the default
 * theme, so we omit them rather than emit a misleading mapping.
 */
export function handleDecide(req: DecideRequest): DecideResponse {
  const featureFlags: DecideResponse["featureFlags"] = {};
  const themes: DecideResponse["themes"] = {};

  for (const flag of getExperiments()) {
    const value = getFeatureFlag(flag, req.distinctId);
    featureFlags[flag.key] = value;

    // Only string values (variant keys) can carry a theme slug. `false`/`true`
    // never map to a theme.
    if (typeof value === "string") {
      const slug = getThemeMap(flag.key)?.[value];
      if (slug !== undefined) themes[flag.key] = slug;
    }
  }

  return { featureFlags, themes };
}

// In-memory event log — the stand-in for the future `Transaction`-attribution
// bridge (README roadmap #4). Storage-free assignment means capture is the ONLY
// thing we persist, and for now "persist" = keep in this array + log it.
const capturedEvents: CaptureRequest[] = [];

/**
 * POST /capture — record one event for a user.
 *
 * We stamp `timestamp` server-side when the client omitted it (so every stored
 * event is ordered), echo it to stdout for live debugging, and return PostHog's
 * `{ status: 1 }` ack. We never reject a well-formed event — capture must be
 * cheap and lossless on the storefront's side.
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
 * GET /flags — list active experiments for debug/admin. We surface only the
 * variant *keys* (not their percentages) since this endpoint is a quick "what's
 * running" view, not the assignment payload.
 */
export function handleFlags(): FlagsResponse {
  return {
    flags: getExperiments().map((flag) => ({
      key: flag.key,
      active: flag.active,
      variants: (flag.variants ?? []).map((v) => v.key),
    })),
  };
}
