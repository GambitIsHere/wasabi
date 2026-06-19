// The client SDK — PostHog's JS developer experience, pointed at OUR endpoints.
//
// Same method names and return contract as PostHog's `posthog-js` / `posthog-node`
// (`getFeatureFlag` → false | true | "<variant>", `isFeatureEnabled`, `getAllFlags`,
// `capture`), so swapping PostHog for Wasabi is a host change, not a rewrite. The
// extra `getTheme` is the Sanjow convenience: it reads the storefront `?theme=`
// slug straight out of the /decide response so a storefront never has to know the
// variant→theme mapping itself.
//
// Like PostHog, we CACHE the /decide payload per distinctId so repeated flag reads
// in a single page/request don't re-hit the network; `reload()` busts that cache.
import type {
  CaptureRequest,
  CaptureResponse,
  DecideRequest,
  DecideResponse,
} from "./wire.ts";
import type { FlagValue } from "./types.ts";

/** SDK configuration. `host` is the engine base URL; `distinctId` is the default user. */
export interface WasabiConfig {
  /** Base URL of the engine, e.g. "https://wasabi.sanjow.app" (no trailing /decide). */
  host: string;
  /** Default user identifier — used whenever a method is called without an explicit distinctId. */
  distinctId?: string;
}

/** The PostHog-shaped client surface. All reads are async (they may hit /decide). */
export interface WasabiClient {
  /** PostHog `getFeatureFlag`: the user's value for `key` — false | true | "<variant>". */
  getFeatureFlag(key: string, distinctId?: string): Promise<FlagValue>;
  /** PostHog `isFeatureEnabled`: true when the user is in the flag (boolean on, or any variant). */
  isFeatureEnabled(key: string, distinctId?: string): Promise<boolean>;
  /** PostHog `getAllFlags`: the full flag→value map for the user (one /decide call). */
  getAllFlags(distinctId?: string): Promise<Record<string, FlagValue>>;
  /** Sanjow convenience: the storefront `?theme=` slug for an experiment, or undefined if none. */
  getTheme(experimentKey: string, distinctId?: string): Promise<string | undefined>;
  /** PostHog `capture`: record an event for the user (fire-and-resolve). */
  capture(
    event: string,
    properties?: Record<string, unknown>,
    distinctId?: string,
  ): Promise<void>;
  /** Bust the cached /decide payload so the next read refetches. Omit id to clear all users. */
  reload(distinctId?: string): void;
}

/**
 * Build a Wasabi client.
 *
 * @throws if a method is called with neither an explicit distinctId nor a
 *         `config.distinctId` default — there's no user to assign.
 */
export function createWasabi(config: WasabiConfig): WasabiClient {
  // Strip a trailing slash so `${host}/decide` never doubles up to `//decide`.
  const host = config.host.replace(/\/+$/, "");

  // Per-user cache of the /decide payload, exactly like PostHog's in-memory flag
  // cache. The cached value is the in-flight or settled Promise (not the resolved
  // value) so concurrent reads for the same user share a SINGLE network call —
  // de-duping the fetch is what makes "read three flags, decide once" hold.
  const decideCache = new Map<string, Promise<DecideResponse>>();

  /** Resolve the effective distinctId or fail loudly — no silent anonymous fallback. */
  function resolveId(distinctId?: string): string {
    const id = distinctId ?? config.distinctId;
    if (id === undefined || id === "") {
      throw new Error(
        "wasabi: no distinctId — pass one to the method or set config.distinctId",
      );
    }
    return id;
  }

  /** POST /decide for a user, memoised per distinctId (PostHog-style flag cache). */
  function decide(distinctId: string): Promise<DecideResponse> {
    const cached = decideCache.get(distinctId);
    if (cached !== undefined) return cached;

    const body: DecideRequest = { distinctId };
    // Cache the Promise immediately (before await) so parallel callers join it.
    const pending = post<DecideResponse>("/decide", body).catch((err: unknown) => {
      // A failed fetch must not poison the cache forever — evict so a later read retries.
      decideCache.delete(distinctId);
      throw err;
    });
    decideCache.set(distinctId, pending);
    return pending;
  }

  /** Minimal JSON POST against the engine using the global fetch (no deps). */
  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${host}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`wasabi: POST ${path} → ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  return {
    async getFeatureFlag(key, distinctId) {
      const { featureFlags } = await decide(resolveId(distinctId));
      // noUncheckedIndexedAccess: a key the server didn't return means "not in flag".
      return featureFlags[key] ?? false;
    },

    async isFeatureEnabled(key, distinctId) {
      const { featureFlags } = await decide(resolveId(distinctId));
      // Enabled = present AND not the literal `false` (boolean-on or any variant string).
      return (featureFlags[key] ?? false) !== false;
    },

    async getAllFlags(distinctId) {
      const { featureFlags } = await decide(resolveId(distinctId));
      return featureFlags;
    },

    async getTheme(experimentKey, distinctId) {
      const { themes } = await decide(resolveId(distinctId));
      // undefined when the experiment isn't running or has no theme slug for the user.
      return themes[experimentKey];
    },

    async capture(event, properties, distinctId) {
      const body: CaptureRequest = {
        distinctId: resolveId(distinctId),
        event,
        ...(properties !== undefined ? { properties } : {}),
      };
      // We ignore the `{status: 1}` ack beyond surfacing transport errors via post().
      await post<CaptureResponse>("/capture", body);
    },

    reload(distinctId) {
      if (distinctId === undefined) {
        decideCache.clear();
      } else {
        decideCache.delete(distinctId);
      }
    },
  };
}
