import { createHash } from "node:crypto";

// PostHog's "long scale" = 2^60 - 1 (fifteen hex f's). We take the first 15
// hex chars of a SHA-1 and divide by this to land in [0, 1).
const LONG_SCALE = 0xfffffffffffffff;

/**
 * Deterministic [0, 1) hash of (key, distinctId, salt).
 *
 * This is byte-for-byte compatible with PostHog's feature-flag hashing
 * (`sha1(`${key}.${distinctId}${salt}`)`, first 15 hex / 2^60-1), so the
 * official PostHog SDKs would assign a given user into exactly the same
 * variant our engine does. Sticky and storage-free: the same inputs always
 * produce the same number, on any machine, with no database lookup.
 */
export function hashValue(key: string, distinctId: string, salt = ""): number {
  const digest = createHash("sha1")
    .update(`${key}.${distinctId}${salt}`)
    .digest("hex");
  return parseInt(digest.slice(0, 15), 16) / LONG_SCALE;
}
