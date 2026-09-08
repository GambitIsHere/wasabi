// ============================================================================
// results-cache.ts — the cache key for an experiment's live Metabase P&L read.
// ----------------------------------------------------------------------------
// The key must bust when anything the cached VALUE depends on changes — the
// theme slugs and cohort start the query reads, plus the controlVariant and
// variant→slug mapping that stamp each row's `variant` label and `isControl`
// flag (lib/metabase.ts runResults) — and stay stable otherwise, so a plain
// rename reuses the cache. These tests pin exactly that contract; see
// app/api/experiments/[key]/results/route.ts for how the key is used.
// ============================================================================
import { describe, expect, it } from "vitest";
import { resultsCacheKeyParts } from "@/lib/results-cache";
import type { RegisteredExperiment } from "@/lib/experiments";

function experiment(overrides: Partial<RegisteredExperiment> = {}): RegisteredExperiment {
  return {
    flag: { key: "tu-billing-uk", active: true, rolloutPercentage: 100, variants: [] },
    name: "TU Billing UK",
    description: "Cheaper SKU vs the default plan.",
    themeMap: { control: "tu_lov_uk", variant_19: "tu_lov_uk_19" },
    controlVariant: "control",
    startDate: "2026-09-01",
    youtrackTicket: "",
    resultsThemeMap: [
      { variant: "control", themeSlug: "tu_lov_uk" },
      { variant: "variant_19", themeSlug: "tu_lov_uk_19" },
    ],
    ...overrides,
  };
}

describe("resultsCacheKeyParts", () => {
  it("includes the namespace, key, start date, control variant and sorted variant:slug pairs", () => {
    expect(resultsCacheKeyParts(experiment())).toEqual([
      "experiment-results",
      "tu-billing-uk",
      "2026-09-01",
      "control",
      "control:tu_lov_uk,variant_19:tu_lov_uk_19",
    ]);
  });

  it("is invariant to variant order (pairs are sorted)", () => {
    const reordered = experiment({
      resultsThemeMap: [
        { variant: "variant_19", themeSlug: "tu_lov_uk_19" },
        { variant: "control", themeSlug: "tu_lov_uk" },
      ],
    });
    expect(resultsCacheKeyParts(reordered)).toEqual(resultsCacheKeyParts(experiment()));
  });

  it("is unchanged by a pure rename / description edit (the query never reads them)", () => {
    const renamed = experiment({ name: "Totally different name", description: "new copy" });
    expect(resultsCacheKeyParts(renamed)).toEqual(resultsCacheKeyParts(experiment()));
  });

  it("busts when a theme slug changes", () => {
    const edited = experiment({
      resultsThemeMap: [
        { variant: "control", themeSlug: "tu_lov_uk" },
        { variant: "variant_19", themeSlug: "tu_lov_uk_29" },
      ],
    });
    expect(resultsCacheKeyParts(edited)).not.toEqual(resultsCacheKeyParts(experiment()));
  });

  it("busts when the cohort start date changes", () => {
    const edited = experiment({ startDate: "2026-10-01" });
    expect(resultsCacheKeyParts(edited)).not.toEqual(resultsCacheKeyParts(experiment()));
  });

  it("drops empty slugs so a blank theme route doesn't churn the key", () => {
    const withBlank = experiment({
      resultsThemeMap: [
        { variant: "control", themeSlug: "tu_lov_uk" },
        { variant: "no_theme", themeSlug: "" },
      ],
    });
    expect(resultsCacheKeyParts(withBlank)).toEqual([
      "experiment-results",
      "tu-billing-uk",
      "2026-09-01",
      "control",
      "control:tu_lov_uk",
    ]);
  });

  it("busts when the control variant is reassigned (slugs and start unchanged)", () => {
    // Same theme slugs and cohort start, but the baseline arm flips from control
    // to variant_19. The cached rows' `isControl` flags derive from this, so the
    // key must change — the slug-only key wrongly reused the old verdict here.
    const reassigned = experiment({ controlVariant: "variant_19" });
    expect(resultsCacheKeyParts(reassigned)).not.toEqual(resultsCacheKeyParts(experiment()));
  });

  it("busts on a variant↔slug remap (same slug set, swapped labels)", () => {
    // The set of slugs is identical, so a slug-only key would not budge — but the
    // per-row `variant` label now points at a different slug, so the key must bust.
    const remapped = experiment({
      resultsThemeMap: [
        { variant: "control", themeSlug: "tu_lov_uk_19" },
        { variant: "variant_19", themeSlug: "tu_lov_uk" },
      ],
    });
    expect(resultsCacheKeyParts(remapped)).not.toEqual(resultsCacheKeyParts(experiment()));
  });
});
