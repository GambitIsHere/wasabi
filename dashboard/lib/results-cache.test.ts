// ============================================================================
// results-cache.ts — the cache key for an experiment's live Metabase P&L read.
// ----------------------------------------------------------------------------
// The key must bust when the query's INPUTS change (theme slugs, cohort start)
// and stay stable otherwise — so a plain rename reuses the cache while a slug or
// start-date edit forces a fresh read. These tests pin exactly that contract;
// see app/api/experiments/[key]/results/route.ts for how the key is used.
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
  it("includes the namespace, key, start date and sorted slugs", () => {
    expect(resultsCacheKeyParts(experiment())).toEqual([
      "experiment-results",
      "tu-billing-uk",
      "2026-09-01",
      "tu_lov_uk,tu_lov_uk_19",
    ]);
  });

  it("is invariant to variant order (slugs are sorted)", () => {
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
      "tu_lov_uk",
    ]);
  });
});
