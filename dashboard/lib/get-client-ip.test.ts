// ============================================================================
// get-client-ip.ts — I5: the rate-limit key must prefer platform-set headers
// over the client-spoofable X-Forwarded-For, so an attacker can't mint a fresh
// rate-limit bucket per request by prepending a fake first hop.
// ============================================================================
import { describe, expect, it } from "vitest";
import { getClientIp } from "@/lib/get-client-ip";

function req(headers: Record<string, string>): Request {
  return new Request("https://wasabi.example/api/x", { headers });
}

describe("getClientIp — header precedence (platform-set first)", () => {
  it("prefers x-vercel-forwarded-for over everything else", () => {
    expect(
      getClientIp(
        req({
          "x-vercel-forwarded-for": "9.9.9.9",
          "x-real-ip": "8.8.8.8",
          "x-forwarded-for": "1.1.1.1",
        }),
      ),
    ).toBe("9.9.9.9");
  });

  it("🔴 a spoofed X-Forwarded-For first hop does NOT win when a platform header is present", () => {
    // Attacker prepends 6.6.6.6 to XFF; x-real-ip (set by the proxy) is trusted first.
    expect(
      getClientIp(
        req({
          "x-real-ip": "8.8.8.8",
          "x-forwarded-for": "6.6.6.6, 8.8.8.8",
        }),
      ),
    ).toBe("8.8.8.8");
  });

  it("falls back to X-Forwarded-For's first hop only when no platform header exists", () => {
    expect(getClientIp(req({ "x-forwarded-for": "3.3.3.3, 4.4.4.4" }))).toBe("3.3.3.3");
  });

  it("takes the first entry of a comma-separated x-vercel-forwarded-for", () => {
    expect(getClientIp(req({ "x-vercel-forwarded-for": "7.7.7.7, 2.2.2.2" }))).toBe("7.7.7.7");
  });

  it("falls back to a shared 'unknown' bucket when no forwarding header is present", () => {
    expect(getClientIp(req({}))).toBe("unknown");
  });

  it("ignores an empty header value and moves to the next", () => {
    expect(
      getClientIp(req({ "x-vercel-forwarded-for": "   ", "x-real-ip": "5.5.5.5" })),
    ).toBe("5.5.5.5");
  });
});
