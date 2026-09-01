// ============================================================================
// hash.ts — behavioural tests for the PostHog-wire-compatible [0,1) hash.
// ----------------------------------------------------------------------------
// hashValue() is the foundation every assignment decision is built on: if it
// silently drifts (a changed digest slice, a changed LONG_SCALE, a changed
// template string), every sticky assignment in production shifts with it. So
// this file checks the documented contract directly — determinism, range,
// salt-sensitivity, rough uniformity — and pins two hand-computed regression
// vectors so an accidental algorithm change fails loudly here instead of
// silently reshuffling live traffic.
// ============================================================================
import { describe, expect, it } from "vitest";
import { hashValue } from "./hash";

describe("hashValue", () => {
  it("is deterministic — same (key, distinctId, salt) always yields the same output", () => {
    const a = hashValue("tu-billing-uk", "user-42");
    const b = hashValue("tu-billing-uk", "user-42");
    expect(a).toBe(b);

    // Also true with a salt, and across repeated calls (not just two).
    const withSalt = Array.from({ length: 5 }, () =>
      hashValue("tu-billing-uk", "user-42", "variant"),
    );
    expect(new Set(withSalt).size).toBe(1);
  });

  it("always returns a number in [0, 1)", () => {
    for (let i = 0; i < 2000; i++) {
      const h = hashValue("range-check-flag", `synthetic-user-${i}`);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });

  it("different salts produce different values for the same key + distinctId", () => {
    const bare = hashValue("tu-billing-uk", "user-42");
    const variantSalt = hashValue("tu-billing-uk", "user-42", "variant");
    const otherSalt = hashValue("tu-billing-uk", "user-42", "other-salt");

    expect(bare).not.toBe(variantSalt);
    expect(bare).not.toBe(otherSalt);
    expect(variantSalt).not.toBe(otherSalt);

    // Not a one-off: hold across a spread of ids too.
    for (let i = 0; i < 50; i++) {
      const id = `salt-check-user-${i}`;
      expect(hashValue("k", id)).not.toBe(hashValue("k", id, "variant"));
    }
  });

  it("distributes roughly uniformly over [0, 1) across a few thousand synthetic ids", () => {
    const N = 5000;
    const BINS = 10;
    const counts = new Array(BINS).fill(0);

    for (let i = 0; i < N; i++) {
      const h = hashValue("uniformity-flag", `synthetic-user-${i}`);
      const bucket = Math.min(BINS - 1, Math.floor(h * BINS));
      counts[bucket]++;
    }

    const expected = N / BINS; // 500
    // Generous tolerance (±40%) — the point is to catch a badly broken hash
    // (e.g. one that's biased into a narrow band), not to chase exact
    // statistical bounds. Inputs are deterministic strings, so this is not
    // flaky: the same 5000 ids hash to the same buckets on every run.
    const tolerance = expected * 0.4;
    for (const count of counts) {
      expect(count).toBeGreaterThan(expected - tolerance);
      expect(count).toBeLessThan(expected + tolerance);
    }
  });

  it("changes when the key changes, all else equal", () => {
    const a = hashValue("flag-a", "same-user");
    const b = hashValue("flag-b", "same-user");
    expect(a).not.toBe(b);
  });

  it("changes when the distinctId changes, all else equal", () => {
    const a = hashValue("same-flag", "user-a");
    const b = hashValue("same-flag", "user-b");
    expect(a).not.toBe(b);
  });

  // -------------------------------------------------------------------------
  // Regression vectors — hand-computed from the documented algorithm
  // (sha1(`${key}.${distinctId}${salt}`), first 15 hex chars / (2^60 - 1)),
  // independently of this module, then pinned as literals. If either value
  // ever changes, the hashing algorithm changed — every existing assignment
  // in production would reshuffle, so this must fail loudly and immediately.
  // -------------------------------------------------------------------------
  it("matches pinned regression vector #1 (no salt)", () => {
    expect(hashValue("test-flag", "user-1")).toBe(0.007041759849595705);
  });

  it("matches pinned regression vector #2 (with salt)", () => {
    expect(hashValue("pricing-experiment", "distinct-id-abc123", "variant")).toBe(
      0.9758232456543453,
    );
  });
});
