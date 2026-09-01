// ============================================================================
// metabase.ts — behavioural tests for the query-input allow-list (M1).
// ----------------------------------------------------------------------------
// isValidThemeSlug / isValidDateInput are the pure guards resultsSql() calls
// before it ever interpolates a slug or a date into native SQL against the
// shared "MAIN DB - Production" payments database — tested directly here, the
// same convention as lib/mgmt.ts's THEME_SLUG_RE / validateInput (see
// lib/mgmt.test.ts).
//
// runResults / runPaymentMetrics are the two public entry points that reach
// resultsSql() (see lib/metabase.ts's header comment on assertValidQueryInputs).
// Both are exercised directly below with a bad slug / bad date to prove the
// rejection actually happens through the real call path, not just in the
// isolated validator. Neither makes a network call in these tests: invalid
// input is rejected before the METABASE_API_KEY / METABASE_URL check ever
// runs (see runResultsRaw's reordering), and the "valid input" cases below
// explicitly stub those env vars empty so they degrade to the documented
// "not configured" outcome instead of ever reaching fetch() — no live
// Metabase / DB dependency either way.
// ============================================================================
import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidDateInput, isValidThemeSlug, runPaymentMetrics, runResults } from "@/lib/metabase";
import type { RegisteredExperiment } from "@/lib/experiments";

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Pure validators
// ---------------------------------------------------------------------------

describe("isValidThemeSlug", () => {
  it("accepts real theme slug shapes", () => {
    expect(isValidThemeSlug("tu_lov_uk")).toBe(true);
    expect(isValidThemeSlug("tu_lov_uk_19")).toBe(true);
    expect(isValidThemeSlug("pdf_auth19")).toBe(true);
    expect(isValidThemeSlug("ac_mto_lov_24_9")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidThemeSlug("")).toBe(false);
  });

  it("rejects a slug starting with a digit", () => {
    expect(isValidThemeSlug("1tu_lov_uk")).toBe(false);
  });

  it("rejects uppercase", () => {
    expect(isValidThemeSlug("TU_LOV_UK")).toBe(false);
  });

  it("rejects whitespace", () => {
    expect(isValidThemeSlug("tu lov uk")).toBe(false);
  });

  it("rejects a quote-based injection attempt", () => {
    expect(isValidThemeSlug("tu_lov_uk'); DROP TABLE \"Theme\"; --")).toBe(false);
  });

  it("rejects a bare single quote appended to an otherwise-real slug", () => {
    expect(isValidThemeSlug("tu_lov_uk'")).toBe(false);
  });

  it("rejects longer than the 50-char Theme.slug column", () => {
    expect(isValidThemeSlug("a".repeat(51))).toBe(false);
  });
});

describe("isValidDateInput", () => {
  it("accepts a plain ISO date", () => {
    expect(isValidDateInput("2026-09-01")).toBe(true);
  });

  it("accepts an ISO datetime with Z", () => {
    expect(isValidDateInput("2026-09-01T00:00:00Z")).toBe(true);
  });

  it("accepts an ISO datetime with milliseconds and Z", () => {
    expect(isValidDateInput("2026-09-01T00:00:00.000Z")).toBe(true);
  });

  it("accepts an ISO datetime with a numeric offset", () => {
    expect(isValidDateInput("2026-09-01T00:00:00+01:00")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidDateInput("")).toBe(false);
  });

  it("rejects a non-ISO date format", () => {
    expect(isValidDateInput("01/09/2026")).toBe(false);
  });

  it("rejects free text", () => {
    expect(isValidDateInput("not-a-date")).toBe(false);
  });

  it("rejects a quote-based injection attempt", () => {
    expect(isValidDateInput("2026-09-01'; DROP TABLE \"Transaction\"; --")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runPaymentMetrics — the attach-payment route's entry point (slugMap +
// window.start/end come straight from the request body there).
// ---------------------------------------------------------------------------

describe("runPaymentMetrics — rejects malformed input before any network call", () => {
  it("rejects a bad slug, naming it in the reason", async () => {
    const outcome = await runPaymentMetrics(["tu_lov_uk", "bad slug!"], "2026-09-01");
    expect(outcome.available).toBe(false);
    expect((outcome as { reason: string }).reason).toMatch(/invalid theme slug "bad slug!"/i);
  });

  it("rejects a bad start date", async () => {
    const outcome = await runPaymentMetrics(["tu_lov_uk"], "not-a-date");
    expect(outcome.available).toBe(false);
    expect((outcome as { reason: string }).reason).toMatch(/invalid start date/i);
  });

  it("rejects a bad end date", async () => {
    const outcome = await runPaymentMetrics(["tu_lov_uk"], "2026-09-01", "also-not-a-date");
    expect(outcome.available).toBe(false);
    expect((outcome as { reason: string }).reason).toMatch(/invalid end date/i);
  });

  it("still reports the pre-existing empty-slugs reason, unchanged", async () => {
    const outcome = await runPaymentMetrics([], "2026-09-01");
    expect(outcome).toEqual({ available: false, reason: "No theme slugs to query" });
  });

  it("still reports the pre-existing missing-start-date reason, unchanged", async () => {
    const outcome = await runPaymentMetrics(["tu_lov_uk"], "");
    expect(outcome).toEqual({ available: false, reason: "No cohort start date to query from" });
  });

  it("lets valid input pass validation through to the (unconfigured) Metabase check", async () => {
    // Proves the allow-list doesn't also reject GOOD input — a valid slug +
    // date reaches the next stage (env config), not a validation error.
    vi.stubEnv("METABASE_API_KEY", "");
    vi.stubEnv("METABASE_URL", "");
    const outcome = await runPaymentMetrics(["tu_lov_uk", "tu_lov_uk_19"], "2026-09-01", "2026-09-30");
    expect(outcome).toEqual({ available: false, reason: "METABASE_API_KEY not configured" });
  });
});

// ---------------------------------------------------------------------------
// runResults — the live experiment results path (app/page.tsx,
// app/api/experiments/[key]/results/route.ts), driven by a RegisteredExperiment
// rather than a raw request body. Same resultsSql() choke point, so the same
// allow-list applies without any change at either call site.
// ---------------------------------------------------------------------------

function fakeExperiment(overrides: Partial<RegisteredExperiment> = {}): RegisteredExperiment {
  return {
    flag: { key: "tu-billing-uk", active: true, rolloutPercentage: 100, variants: [] },
    name: "TU Billing UK Test",
    description: "Cheaper SKU vs the default plan.",
    themeMap: { control: "tu_lov_uk" },
    controlVariant: "control",
    startDate: "2026-09-01",
    resultsThemeMap: [{ variant: "control", themeSlug: "tu_lov_uk" }],
    ...overrides,
  };
}

describe("runResults — the same allow-list guards the live results path", () => {
  it("rejects an experiment whose resultsThemeMap carries a malformed slug", async () => {
    const outcome = await runResults(
      fakeExperiment({ resultsThemeMap: [{ variant: "control", themeSlug: "bad slug!" }] }),
    );
    expect(outcome.available).toBe(false);
    expect((outcome as { reason: string }).reason).toMatch(/invalid theme slug/i);
  });

  it("rejects an experiment with a malformed startDate", async () => {
    const outcome = await runResults(fakeExperiment({ startDate: "not-a-date" }));
    expect(outcome.available).toBe(false);
    expect((outcome as { reason: string }).reason).toMatch(/invalid start date/i);
  });

  it("a real, valid experiment still reaches the (unconfigured) Metabase check — the results path isn't broken", async () => {
    vi.stubEnv("METABASE_API_KEY", "");
    vi.stubEnv("METABASE_URL", "");
    const outcome = await runResults(fakeExperiment());
    expect(outcome).toEqual({ available: false, reason: "METABASE_API_KEY not configured" });
  });
});
