// ============================================================================
// Client IP resolution (server-only) — used by the per-IP rate limiter.
// ----------------------------------------------------------------------------
// Vercel (and any reverse proxy in front of a Node server) sets X-Forwarded-For
// to a comma-separated hop chain, client first: "client, proxy1, proxy2, ...".
// The Fetch API's Request has no built-in `.ip`, so this is the standard way
// to recover it. Best-effort by nature — headers are caller-supplied and not
// cryptographically trustworthy, so this is fit for rate-limiting (bucketing
// abusive traffic) and NOT for anything security-sensitive like an allowlist.
// ============================================================================

/**
 * Best-effort client IP for one request. Falls back to a single shared
 * "unknown" bucket (rather than throwing) when no forwarding header is
 * present — e.g. a direct localhost curl in dev.
 */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  // Vercel's edge network also sets this; a useful fallback when XFF is absent.
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  return "unknown";
}
