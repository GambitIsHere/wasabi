// ============================================================================
// variant-readiness.ts — the readiness heuristic.
// ----------------------------------------------------------------------------
// The pure recognition helpers are tested directly. checkVariantReadiness (which
// scans the filesystem) is exercised against a TEMP fixture repo — a throwaway
// directory laid out like a storefront checkout — so all four states (built via
// grep, built data-only, not-built, unknown) are covered without touching a real
// repo. Each fs test uses a UNIQUE slug so the 5-minute readiness cache never
// bleeds one case into another.
// ============================================================================
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  segmentRecognized,
  segmentsRecognized,
  resolveStorefrontRepo,
  checkVariantReadiness,
} from "@/lib/variant-readiness";

describe("segmentRecognized", () => {
  it("recognises known theme-slug segments, business prefixes, locales and price tokens", () => {
    expect(segmentRecognized("tu")).toBe(true); // business prefix
    expect(segmentRecognized("lov")).toBe(true); // seen in tu_lov_*
    expect(segmentRecognized("uk")).toBe(true); // market code
    expect(segmentRecognized("fr")).toBe(true); // locale
    expect(segmentRecognized("19")).toBe(true); // numeric price token
    expect(segmentRecognized("1m")).toBe(true); // digits + unit letter
    expect(segmentRecognized("auth19")).toBe(true); // seen in pdf_auth19
  });

  it("rejects novel words that would need building", () => {
    expect(segmentRecognized("marquee")).toBe(false);
    expect(segmentRecognized("banner")).toBe(false);
    expect(segmentRecognized("zzz")).toBe(false);
  });
});

describe("segmentsRecognized", () => {
  it("is true only when EVERY segment is recognised", () => {
    expect(segmentsRecognized("tu_lov_uk")).toBe(true);
    expect(segmentsRecognized("tu_lov_fr")).toBe(true);
    expect(segmentsRecognized("ac_mto_lov_24_9")).toBe(true);
    expect(segmentsRecognized("as_sub_1m_19")).toBe(true);
  });

  it("is false when any segment is novel (safe bias toward not-built)", () => {
    expect(segmentsRecognized("tu_promo_banner")).toBe(false);
    expect(segmentsRecognized("marquee")).toBe(false);
    expect(segmentsRecognized("control")).toBe(false);
  });

  it("is false for a malformed slug", () => {
    expect(segmentsRecognized("TU_LOV_UK")).toBe(false); // uppercase fails THEME_SLUG_RE
    expect(segmentsRecognized("")).toBe(false);
  });
});

describe("resolveStorefrontRepo", () => {
  it("maps the four lane businesses to their repos", () => {
    expect(resolveStorefrontRepo("Top Up")).toBe("prepaid-mobile-recharge-ai");
    expect(resolveStorefrontRepo("Airport Check-In")).toBe("checkin-ai");
    expect(resolveStorefrontRepo("Airport Security")).toBe("fast-track-ai");
    expect(resolveStorefrontRepo("PDF SaaS")).toBe("pdf");
  });

  it("returns null for a business with no storefront lane", () => {
    expect(resolveStorefrontRepo("Global Tickets")).toBeNull();
    expect(resolveStorefrontRepo("Nonsense")).toBeNull();
  });
});

describe("checkVariantReadiness", () => {
  let root: string;
  const prevRoot = process.env.STOREFRONTS_ROOT;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "wasabi-storefronts-"));
    const repoDir = join(root, "prepaid-mobile-recharge-ai");
    mkdirSync(join(repoDir, "app"), { recursive: true });
    // A source file that literally references a novel arm slug + a var value.
    writeFileSync(
      join(repoDir, "app", "promo.ts"),
      `export const ARM = "tu_greponly_novel";\nexport const V = "marqueebespoke";\n`,
    );
    process.env.STOREFRONTS_ROOT = root;
  });

  afterAll(() => {
    if (prevRoot === undefined) delete process.env.STOREFRONTS_ROOT;
    else process.env.STOREFRONTS_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it("returns BUILT on a literal grep hit — even for an otherwise-novel slug", () => {
    const r = checkVariantReadiness("Top Up", "tu_greponly_novel");
    expect(r.state).toBe("built");
    expect(r.matchedFile).toContain("promo.ts");
  });

  it("returns BUILT (data-only) when no literal hit but every segment is recognised", () => {
    const r = checkVariantReadiness("Top Up", "tu_lov_ie");
    expect(r.state).toBe("built");
    expect(r.matchedFile).toBeUndefined();
    expect(r.reason).toMatch(/data-only/i);
  });

  it("returns NOT-BUILT when there is no hit and a segment is novel", () => {
    const r = checkVariantReadiness("Top Up", "tu_neverseen_bespoke");
    expect(r.state).toBe("not-built");
  });

  it("returns UNKNOWN when the storefront checkout is not on disk", () => {
    const r = checkVariantReadiness("PDF SaaS", "pdf_unbuilt_here");
    expect(r.state).toBe("unknown");
  });

  it("returns UNKNOWN for a business with no mapped storefront", () => {
    const r = checkVariantReadiness("Global Tickets", "gt_anything_x");
    expect(r.state).toBe("unknown");
  });

  it("treats a malformed slug as not-built (needs a real slug first)", () => {
    const r = checkVariantReadiness("Top Up", "NOT A SLUG");
    expect(r.state).toBe("not-built");
  });
});
