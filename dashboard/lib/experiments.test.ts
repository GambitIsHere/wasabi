// ============================================================================
// experiments.ts — I12: getProjectThemeSlugs is the project-scoped allow-list
// that stops one tenant querying another brand's revenue / theme names off the
// shared global-api Metabase (used by attach-payment + /api/admin/themes).
// ----------------------------------------------------------------------------
// listExperiments() is tenant-scoped (lib/store.ts filters by projectId), so
// the slug set this builds contains only the caller's own project's slugs. The
// store is mocked (DB-free unit-test convention); the mapping/dedup logic is
// what's under test.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/store", () => ({
  listExperiments: vi.fn(),
  getExperiment: vi.fn(),
  toRegistered: vi.fn(),
}));

import { listExperiments, toRegistered } from "@/lib/store";
import { getProjectThemeSlugs } from "@/lib/experiments";
import type { RegisteredExperiment } from "@/lib/experiments";
import type { StoredExperiment } from "@/lib/mgmt";

const mockList = vi.mocked(listExperiments);
const mockToRegistered = vi.mocked(toRegistered);

/** A RegisteredExperiment stub — getProjectThemeSlugs only reads resultsThemeMap. */
function reg(slugs: string[]): RegisteredExperiment {
  return {
    resultsThemeMap: slugs.map((themeSlug, i) => ({ variant: `v${i}`, themeSlug })),
  } as unknown as RegisteredExperiment;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getProjectThemeSlugs (I12)", () => {
  it("collects every theme slug across the project's experiments, deduped", async () => {
    mockList.mockResolvedValue([{}, {}] as unknown as StoredExperiment[]);
    mockToRegistered
      .mockReturnValueOnce(reg(["tu_lov_uk", "tu_lov_uk_19"]))
      .mockReturnValueOnce(reg(["tu_lov_uk", "ac_mto_lov"])); // tu_lov_uk repeats

    const slugs = await getProjectThemeSlugs();

    expect([...slugs].sort()).toEqual(["ac_mto_lov", "tu_lov_uk", "tu_lov_uk_19"]);
  });

  it("is an empty set for a project with no experiments (nothing queryable)", async () => {
    mockList.mockResolvedValue([]);
    const slugs = await getProjectThemeSlugs();
    expect(slugs.size).toBe(0);
  });

  it("does not include an arbitrary/other-brand slug the project never references", async () => {
    mockList.mockResolvedValue([{}] as unknown as StoredExperiment[]);
    mockToRegistered.mockReturnValueOnce(reg(["tu_lov_uk"]));

    const slugs = await getProjectThemeSlugs();

    expect(slugs.has("some_other_brand_slug")).toBe(false);
    expect(slugs.has("tu_lov_uk")).toBe(true);
  });
});
