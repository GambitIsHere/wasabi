// ============================================================================
// storefronts.ts — the business → storefront map used by the create-form's
// live preview. Pure, so the URL composition + framing decision are pinned by
// tests: a wrong origin or a dropped `?theme=` would ship a broken preview.
// ============================================================================
import { describe, expect, it } from "vitest";
import { STOREFRONTS, previewUrlFor, storefrontFor } from "@/lib/storefronts";

describe("storefrontFor", () => {
  it("resolves each wired business to its production origin", () => {
    expect(storefrontFor("Top Up")?.url).toBe("https://topup-mobile.co");
    expect(storefrontFor("Airport Check-In")?.url).toBe("https://checkin.my-trip-online.com");
    expect(storefrontFor("Airport Security")?.url).toBe("https://travel-synch.com");
    expect(storefrontFor("PDF SaaS")?.url).toBe("https://www.we-pdf.online");
  });

  it("returns null for a business with no wired storefront", () => {
    expect(storefrontFor("Global Tickets")).toBeNull();
    expect(storefrontFor("Global Visa")).toBeNull();
    expect(storefrontFor("Gift Cards")).toBeNull();
    expect(storefrontFor("Airport Lounges")).toBeNull();
  });

  it("returns null (never throws) for an unknown / stale business value", () => {
    expect(storefrontFor("Not A Business")).toBeNull();
    expect(storefrontFor("")).toBeNull();
  });

  it("every wired storefront declares a framing decision and a clean origin", () => {
    for (const sf of Object.values(STOREFRONTS)) {
      expect(sf).toBeDefined();
      expect(["allow", "block"]).toContain(sf!.framing);
      // Origin only — no trailing slash, path, or query (previewUrlFor appends).
      expect(sf!.url).toMatch(/^https:\/\/[^/?#]+$/);
    }
  });
});

describe("previewUrlFor", () => {
  it("appends ?theme=<slug> to the storefront origin", () => {
    expect(previewUrlFor("Top Up", "tu_lov_uk_19")).toBe(
      "https://topup-mobile.co?theme=tu_lov_uk_19",
    );
    expect(previewUrlFor("PDF SaaS", "pdf_auth49")).toBe(
      "https://www.we-pdf.online?theme=pdf_auth49",
    );
  });

  it("trims and URL-encodes the slug", () => {
    expect(previewUrlFor("Top Up", "  tu_lov_uk  ")).toBe(
      "https://topup-mobile.co?theme=tu_lov_uk",
    );
  });

  it("returns null when the business has no storefront", () => {
    expect(previewUrlFor("Global Tickets", "gt_default")).toBeNull();
  });

  it("returns null when the slug is blank", () => {
    expect(previewUrlFor("Top Up", "")).toBeNull();
    expect(previewUrlFor("Top Up", "   ")).toBeNull();
  });
});
