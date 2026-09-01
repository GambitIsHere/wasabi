// ============================================================================
// Client IP resolution (server-only) — used by the per-IP rate limiter.
// ----------------------------------------------------------------------------
// The Fetch API's Request has no built-in `.ip`, so we recover it from a
// forwarding header. HEADER ORDER MATTERS FOR SECURITY: `X-Forwarded-For` is a
// comma-separated hop chain whose FIRST entry a client can freely PREPEND, so
// keying a rate limiter off XFF-first lets an attacker mint a fresh bucket per
// request by rotating the spoofed first hop. So we prefer the headers the
// PLATFORM sets and the client cannot forge past the edge:
//   1. x-vercel-forwarded-for — Vercel-set, the real client IP (preferred).
//   2. x-real-ip              — also platform-set (Vercel / most proxies).
//   3. x-forwarded-for[0]     — last resort; spoofable, but better than nothing.
// Still best-effort and NOT cryptographically trustworthy — fit for
// rate-limiting (bucketing abusive traffic), never for an allowlist.
// ============================================================================

/** First non-empty comma-separated entry of a header value, trimmed. */
function firstHop(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/**
 * Best-effort client IP for one request. Prefers platform-set headers over the
 * client-spoofable `X-Forwarded-For` (see this module's header). Falls back to a
 * single shared "unknown" bucket (rather than throwing) when no forwarding
 * header is present — e.g. a direct localhost curl in dev.
 */
export function getClientIp(request: Request): string {
  return (
    firstHop(request.headers.get("x-vercel-forwarded-for")) ??
    firstHop(request.headers.get("x-real-ip")) ??
    firstHop(request.headers.get("x-forwarded-for")) ??
    "unknown"
  );
}
