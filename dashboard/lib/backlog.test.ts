// ============================================================================
// backlog.ts — behavioural tests for the pure prefill helpers.
// ----------------------------------------------------------------------------
// suggestedName() and suggestedThemeSlug() turn a raw YouTrack ticket summary
// (and description) into seed values for the "+ Test" form. Both are pure
// string functions with no I/O, so they're tested directly — no need to touch
// the YouTrack client this file also imports. Uses "@/lib/backlog" to also
// exercise the `@/` path alias under Vitest.
// ============================================================================
import { describe, expect, it } from "vitest";
import { suggestedName, suggestedThemeSlug } from "@/lib/backlog";
import { THEME_SLUG_RE } from "@/lib/mgmt";

describe("suggestedName", () => {
  it("strips a leading business prefix + hyphen separator", () => {
    expect(suggestedName("TU - Billing test 39 + 19 UK")).toBe("Billing test 39 + 19 UK");
  });

  it("strips a leading business prefix with a colon separator", () => {
    expect(suggestedName("AC: New check-in theme A/B")).toBe("New check-in theme A/B");
  });

  it("strips a leading business prefix with a pipe separator", () => {
    expect(suggestedName("PDF | Pricing page split test")).toBe("Pricing page split test");
  });

  it("matches the prefix case-insensitively", () => {
    expect(suggestedName("ac - lowercase prefix works too")).toBe("lowercase prefix works too");
  });

  it("recognises multi-letter prefixes (WePDF, AICHAT)", () => {
    expect(suggestedName("WePDF - subscription tiers experiment")).toBe(
      "subscription tiers experiment",
    );
    expect(suggestedName("AICHAT: onboarding flow test")).toBe("onboarding flow test");
  });

  it("trims surrounding whitespace after stripping the prefix", () => {
    expect(suggestedName("   TU -   Billing test  ")).toBe("Billing test");
  });

  it("leaves the summary untouched when it has no recognised prefix", () => {
    expect(suggestedName("Random ticket title without a prefix")).toBe(
      "Random ticket title without a prefix",
    );
  });

  it("does not strip a prefix-like token unless a real separator follows it (no false-positive substring match)", () => {
    // "ACME" starts with the known prefix "AC" but there's no "-|:–" right
    // after it, so the anchored regex must NOT match here.
    expect(suggestedName("ACME - foo")).toBe("ACME - foo");
  });

  it("does not strip a bare prefix with no separator punctuation at all", () => {
    expect(suggestedName("TU Something without punctuation")).toBe(
      "TU Something without punctuation",
    );
  });

  it("caps the result at 120 characters", () => {
    const long = "TU - " + "x".repeat(150);
    const result = suggestedName(long);
    expect(result.length).toBe(120);
    expect(result).toBe("x".repeat(120));
  });
});

describe("suggestedThemeSlug", () => {
  it("prefers an explicit theme= cue", () => {
    expect(suggestedThemeSlug("Please use theme=tu_lov_uk_19 for this variant")).toBe(
      "tu_lov_uk_19",
    );
  });

  it("accepts theme: (colon) as the cue separator, and lower-cases the result", () => {
    expect(suggestedThemeSlug("theme: AS_SUB_1M_19")).toBe("as_sub_1m_19");
  });

  it("prefers the explicit cue over a different shaped token also present in the text", () => {
    const text = "theme=tu_lov_uk_19 — also mentions ac_mto_lov elsewhere in the ticket";
    expect(suggestedThemeSlug(text)).toBe("tu_lov_uk_19");
  });

  it("falls back to a slug-shaped token when there is no explicit cue", () => {
    expect(suggestedThemeSlug("New theme tu_lov_uk_19 for the billing test")).toBe(
      "tu_lov_uk_19",
    );
  });

  it("finds a shaped token from a business prefix other than tu (ac, pdf, as, ...)", () => {
    expect(suggestedThemeSlug("Rolling out ac_mto_lov_24_9 to check-in")).toBe(
      "ac_mto_lov_24_9",
    );
    expect(suggestedThemeSlug("New SKU pdf_auth49 for the paywall")).toBe("pdf_auth49");
  });

  it("returns null when neither an explicit cue nor a shaped token is present", () => {
    expect(suggestedThemeSlug("Just a plain ticket about performance monitoring")).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(suggestedThemeSlug("")).toBeNull();
  });

  it("never returns a value that fails THEME_SLUG_RE, across a range of inputs", () => {
    const samples = [
      "theme=tu_lov_uk_19",
      "theme:AS_SUB_1M_19",
      "theme =  pdf_auth19 please",
      "no cue here but tu_lov_uk_39 is mentioned",
      "AC_MTO_LOV in all caps with no explicit cue",
      "nothing relevant in this ticket at all",
      "theme=",
      "theme=!!!not-a-slug",
      "multiple tokens: tu_a and ac_b and as_c",
      "",
      "   ",
      "gc_default and al_lounge_1 together",
    ];
    for (const text of samples) {
      const result = suggestedThemeSlug(text);
      if (result !== null) {
        expect(THEME_SLUG_RE.test(result)).toBe(true);
      }
    }
  });
});
