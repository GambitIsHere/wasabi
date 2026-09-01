// ============================================================================
// rate-limit.ts — behavioural tests for the token bucket.
// ----------------------------------------------------------------------------
// New in A3 (see CLAUDE.md): a lightweight per-IP guard on /api/capture, so
// it gets its own focused coverage alongside the five pure modules A1 names
// explicitly — it's new pure logic protecting a public write endpoint, and a
// broken rate limiter (never blocks, or blocks everyone) would defeat the
// point of gating the endpoint at all. Every test drives its own `now` clock
// (no real sleeps) and uses a unique bucket key so tests never share state
// through the module-level bucket map.
// ============================================================================
import { describe, expect, it } from "vitest";
import { perMinute, takeToken } from "./rate-limit";

describe("takeToken", () => {
  it("allows up to `capacity` requests as an immediate burst, then rejects", () => {
    const key = "burst-test";
    const opts = { capacity: 3, refillPerMs: 0 }; // no refill — isolates the burst behaviour
    const now = 1_000_000;

    expect(takeToken(key, opts, now)).toBe(true);
    expect(takeToken(key, opts, now)).toBe(true);
    expect(takeToken(key, opts, now)).toBe(true);
    expect(takeToken(key, opts, now)).toBe(false); // 4th request in the same instant: rejected
  });

  it("refills over time and allows exactly one more request per full token accrued", () => {
    const key = "refill-test";
    const opts = { capacity: 1, refillPerMs: perMinute(60) }; // 1 token/sec steady-state
    let now = 2_000_000;

    expect(takeToken(key, opts, now)).toBe(true); // spends the only token
    expect(takeToken(key, opts, now)).toBe(false); // no time passed — still empty

    now += 500; // half a second later — not enough for a full token yet
    expect(takeToken(key, opts, now)).toBe(false);

    now += 500; // now a full second has passed since the first call — exactly 1 token
    expect(takeToken(key, opts, now)).toBe(true);
    expect(takeToken(key, opts, now)).toBe(false); // spent again immediately
  });

  it("never refills past capacity, even after a very long idle period", () => {
    const key = "cap-test";
    const opts = { capacity: 2, refillPerMs: perMinute(60) };
    let now = 3_000_000;

    expect(takeToken(key, opts, now)).toBe(true);
    expect(takeToken(key, opts, now)).toBe(true);
    expect(takeToken(key, opts, now)).toBe(false); // capacity 2, both spent

    now += 1000 * 60 * 60 * 24; // a full day idle
    // Capped at capacity (2), not one-token-per-second-of-the-day: exactly 2 allowed.
    expect(takeToken(key, opts, now)).toBe(true);
    expect(takeToken(key, opts, now)).toBe(true);
    expect(takeToken(key, opts, now)).toBe(false);
  });

  it("tracks distinct keys independently — exhausting one key's bucket doesn't affect another", () => {
    const opts = { capacity: 1, refillPerMs: 0 };
    const now = 4_000_000;

    expect(takeToken("independent-key-a", opts, now)).toBe(true);
    expect(takeToken("independent-key-a", opts, now)).toBe(false); // a's bucket is empty

    // b is unaffected by a being exhausted.
    expect(takeToken("independent-key-b", opts, now)).toBe(true);
  });

  it("bounds memory — once past the tracked-key limit, the coldest key is evicted and starts fresh", () => {
    const opts = { capacity: 1, refillPerMs: 0 }; // never refills — isolates eviction from refill
    const now = 5_000_000;

    expect(takeToken("evict-target", opts, now)).toBe(true); // spends its only token
    expect(takeToken("evict-target", opts, now)).toBe(false); // confirmed: state is remembered

    // Push well past MAX_TRACKED_KEYS (5000) with other keys so "evict-target",
    // untouched since the calls above, becomes the coldest entry and gets evicted.
    for (let i = 0; i < 5500; i++) {
      takeToken(`filler-key-${i}`, opts, now);
    }

    // If "evict-target" were still tracked it would still read as empty (false).
    // A fresh `true` proves its state was forgotten and re-initialised.
    expect(takeToken("evict-target", opts, now)).toBe(true);
  });
});

describe("perMinute", () => {
  it("converts an N-per-minute rate into tokens-per-millisecond", () => {
    expect(perMinute(60)).toBeCloseTo(1 / 1000, 12); // 1 token/sec
    expect(perMinute(60_000)).toBeCloseTo(1, 12); // 1 token/ms
    expect(perMinute(0)).toBe(0);
  });
});
