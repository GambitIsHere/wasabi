// ============================================================================
// In-memory token-bucket rate limiter (server-only).
// ----------------------------------------------------------------------------
// Guards public, unauthenticated write endpoints — today just /api/capture
// (see the A3 gating note in app/api/capture/route.ts) — against a flood from
// one source. A token bucket rather than a fixed window: it allows a natural
// burst (a page firing several events on load) while still capping the
// sustained rate, which a fixed window would either over- or under-allow at
// the window edges.
//
// IMPORTANT — this is PER SERVERLESS INSTANCE, not global. Vercel can run many
// concurrent instances of a function, each with its own module-level state,
// and an instance can be recycled at any time — so a determined attacker
// spread across instances (or simply hitting a fresh cold start) sees a higher
// effective ceiling than the configured rate. This bounds the blast radius of
// one sustained source hammering ONE warm instance; it is NOT a hard global
// cap across the deployment. That trade-off is deliberate: zero added infra,
// zero added latency, no network round trip on every capture. A real global
// limit would need a shared store (e.g. Upstash Redis) — revisit if abuse
// proves this insufficient.
// ============================================================================

interface Bucket {
  /** Tokens currently available (fractional between refills). */
  tokens: number;
  /** Wall-clock ms this bucket was last touched. */
  lastRefillMs: number;
}

export interface TokenBucketOptions {
  /** Max tokens the bucket can hold — the allowed instantaneous burst. */
  capacity: number;
  /** Tokens added per millisecond — the steady-state allowed rate. */
  refillPerMs: number;
}

/** Convenience: the refill rate for a plain "N per minute" limit. */
export function perMinute(n: number): number {
  return n / 60_000;
}

const buckets = new Map<string, Bucket>();

// Bound memory: many distinct IPs hitting an unauthenticated endpoint could
// otherwise grow this map without limit for the life of the instance. Once at
// capacity, tracking a new key evicts the least-recently-touched one — every
// touch below re-inserts its key, and a Map iterates in insertion order, so
// the first key iterated is always the coldest.
const MAX_TRACKED_KEYS = 5000;

/**
 * Attempt to spend one token for `key` (typically a client IP). Returns
 * `true` when a token was available (request allowed, one token spent) and
 * `false` when the bucket was empty (request should be rejected — the caller
 * decides the response, typically 429).
 *
 * `now` is a parameter (defaulting to `Date.now()`) purely so tests can drive
 * the clock deterministically without real sleeps.
 */
export function takeToken(
  key: string,
  opts: TokenBucketOptions,
  now: number = Date.now(),
): boolean {
  const existing = buckets.get(key);
  if (existing) {
    buckets.delete(key); // re-inserted below — marks it most-recently-used
  } else if (buckets.size >= MAX_TRACKED_KEYS) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey !== undefined) buckets.delete(oldestKey);
  }

  const bucket: Bucket = existing ?? { tokens: opts.capacity, lastRefillMs: now };
  const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
  const refilled = Math.min(opts.capacity, bucket.tokens + elapsedMs * opts.refillPerMs);

  const allowed = refilled >= 1;
  bucket.tokens = allowed ? refilled - 1 : refilled;
  bucket.lastRefillMs = now;
  buckets.set(key, bucket);

  return allowed;
}
