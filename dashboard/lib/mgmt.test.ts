// ============================================================================
// mgmt.ts — behavioural tests for validateInput, slugify, splitTotal.
// ----------------------------------------------------------------------------
// validateInput is the single source of truth shared by the client form and
// the server action, so every business rule it enforces gets its own test:
// each failure mode isolated (only the field under test is invalid — every
// other field is a valid baseline), asserting the exact returned message.
// Imports via "@/lib/mgmt" to also exercise the `@/` path alias under Vitest.
// ============================================================================
import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_MAX,
  buildCloneInput,
  businessCode,
  cloneName,
  composeExperimentName,
  evenSplit,
  isValidYoutrackTicket,
  keyFromIdOrName,
  nextExpId,
  slugify,
  splitTotal,
  validateInput,
  youtrackTicketHref,
  type ExperimentInput,
  type StoredExperiment,
  type VariantInput,
} from "@/lib/mgmt";

/**
 * validateInput takes the allowed goal-metric set as an explicit parameter
 * now (it moved from a module constant to the registry — see lib/mgmt.ts's
 * header on validateInput). Every test below that isn't specifically about
 * goal-metric validation just wants a realistic, always-valid default, so
 * `validate()` supplies one — mirroring 4 of the real seeded registry keys
 * (lib/seeds.ts's SEED_METRICS) without this pure-module test depending on
 * the DB-backed registry itself.
 */
const ALLOWED_GOAL_METRICS = ["auth_rate", "rebill_rate", "rev_per_acquired", "apps_acquired"];
function validate(input: ExperimentInput, allowed: readonly string[] = ALLOWED_GOAL_METRICS) {
  return validateInput(input, allowed);
}

/** A fresh, fully valid input — each test overrides only what it's testing. */
function validInput(overrides: Partial<ExperimentInput> = {}): ExperimentInput {
  return {
    name: "TU Billing UK Test",
    business: "Top Up",
    goalMetric: "auth_rate",
    startDate: "2026-09-01",
    description: "Cheaper SKU vs the default £49 plan.",
    variants: [
      { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
      { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
    ],
    ...overrides,
  };
}

describe("validateInput — valid input", () => {
  it("returns null for a fully valid input", () => {
    expect(validate(validInput())).toBeNull();
  });

  it("accepts a description at exactly the length cap (boundary, not off-by-one)", () => {
    expect(validate(validInput({ description: "a".repeat(DESCRIPTION_MAX) }))).toBeNull();
  });

  it("accepts an explicit, valid key (the default fixture already covers the omitted-key/derived-via-slugify path)", () => {
    expect(validate(validInput({ key: "custom-experiment-key" }))).toBeNull();
  });
});

describe("validateInput — failure modes", () => {
  it("rejects an empty name", () => {
    expect(validate(validInput({ name: "" }))).toBe("Name is required.");
    expect(validate(validInput({ name: "   " }))).toBe("Name is required.");
  });

  it("rejects a description over the length cap", () => {
    const msg = validate(validInput({ description: "a".repeat(DESCRIPTION_MAX + 1) }));
    expect(msg).toBe(
      `Description must be ${DESCRIPTION_MAX} characters or fewer (currently ${DESCRIPTION_MAX + 1}).`,
    );
  });

  it("rejects a business outside the allowed set", () => {
    const msg = validate(validInput({ business: "Not A Real Business" }));
    expect(msg).toMatch(/^Business must be one of:/);
  });

  it("rejects a goal metric outside the allowed set", () => {
    const msg = validate(validInput({ goalMetric: "clicks" }));
    expect(msg).toMatch(/^Goal metric must be one of:/);
  });

  it("the allowed set is a real parameter, not a hidden module constant — the SAME goalMetric is valid or invalid purely depending on what's passed in", () => {
    const input = validInput({ goalMetric: "rebill_rate" });
    // Valid against a set that includes it…
    expect(validateInput(input, ["auth_rate", "rebill_rate"])).toBeNull();
    // …and rejected against one that doesn't, even though "rebill_rate" is a
    // perfectly real metric key in the app's actual registry today. Proves
    // validateInput trusts its caller's list, not some default it fell back to.
    expect(validateInput(input, ["auth_rate"])).toMatch(/^Goal metric must be one of: auth_rate\.$/);
  });

  it("accepts a goal metric that exists ONLY because the caller explicitly included it — the degrade-gracefully case for an experiment created before the registry, or whose goal metric was since renamed", () => {
    const input = validInput({ goalMetric: "revenue_per_acquired" });
    // Not one of the current registry's real keys — app/actions.ts's
    // updateExperiment unions an experiment's own current goalMetric into the
    // allowed set specifically so this keeps validating instead of blocking
    // every future edit to that experiment.
    const allowedWithLegacyValue = [...ALLOWED_GOAL_METRICS, "revenue_per_acquired"];
    expect(validateInput(input, allowedWithLegacyValue)).toBeNull();
  });

  it("rejects a malformed start date", () => {
    expect(validate(validInput({ startDate: "01/09/2026" }))).toBe(
      "Start date must be a valid date (YYYY-MM-DD).",
    );
  });

  it("rejects a bad explicit key (uppercase / spaces / punctuation)", () => {
    const msg = validate(validInput({ key: "Bad Key!" }));
    expect(msg).toBe(
      "Key must be lower-case letters, numbers and hyphens (e.g. tu-billing-uk).",
    );
  });

  it("rejects when the auto-derived key (slugify of an all-punctuation name) is empty", () => {
    const msg = validate(validInput({ name: "!!!" }));
    expect(msg).toBe(
      "Key must be lower-case letters, numbers and hyphens (e.g. tu-billing-uk).",
    );
  });

  it("rejects fewer than 2 variants", () => {
    const msg = validate(
      validInput({
        variants: [{ key: "control", rolloutPercentage: 100, themeSlug: "tu_lov_uk", isControl: true }],
      }),
    );
    expect(msg).toBe("An experiment needs at least 2 variants.");
  });

  it("rejects an invalid variant key", () => {
    const msg = validate(
      validInput({
        variants: [
          { key: "Bad Key", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
          { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
        ],
      }),
    );
    expect(msg).toMatch(/^Variant key "Bad Key" is invalid/);
  });

  it("rejects duplicate variant keys", () => {
    const msg = validate(
      validInput({
        variants: [
          { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
          { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
        ],
      }),
    );
    expect(msg).toBe('Duplicate variant key "control".');
  });

  it("rejects a non-integer or out-of-range rollout percentage", () => {
    const nonInteger = validate(
      validInput({
        variants: [
          { key: "control", rolloutPercentage: 50.5, themeSlug: "tu_lov_uk", isControl: true },
          { key: "variant_19", rolloutPercentage: 49.5, themeSlug: "tu_lov_uk_19", isControl: false },
        ],
      }),
    );
    expect(nonInteger).toMatch(/split must be a whole number between 0 and 100/);

    const outOfRange = validate(
      validInput({
        variants: [
          { key: "control", rolloutPercentage: 120, themeSlug: "tu_lov_uk", isControl: true },
          { key: "variant_19", rolloutPercentage: -20, themeSlug: "tu_lov_uk_19", isControl: false },
        ],
      }),
    );
    expect(outOfRange).toMatch(/split must be a whole number between 0 and 100/);
  });

  it("rejects an invalid theme slug", () => {
    const msg = validate(
      validInput({
        variants: [
          { key: "control", rolloutPercentage: 50, themeSlug: "UPPERCASE_NOT_ALLOWED", isControl: true },
          { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
        ],
      }),
    );
    expect(msg).toMatch(/^Variant "control" theme slug "UPPERCASE_NOT_ALLOWED" is invalid/);
  });

  it("rejects variant splits that don't sum to exactly 100", () => {
    const msg = validate(
      validInput({
        variants: [
          { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
          { key: "variant_19", rolloutPercentage: 40, themeSlug: "tu_lov_uk_19", isControl: false },
        ],
      }),
    );
    expect(msg).toBe("Variant splits must sum to exactly 100% (currently 90%).");
  });

  it("rejects when no variant is marked as the control", () => {
    const msg = validate(
      validInput({
        variants: [
          { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: false },
          { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
        ],
      }),
    );
    expect(msg).toBe("Exactly one variant must be marked as the control.");
  });

  it("rejects when more than one variant is marked as the control", () => {
    const msg = validate(
      validInput({
        variants: [
          { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
          { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: true },
        ],
      }),
    );
    expect(msg).toBe("Exactly one control allowed — 2 are marked.");
  });
});

describe("slugify", () => {
  it("matches the documented example exactly", () => {
    expect(slugify("Top-Up Billing UK!")).toBe("top-up-billing-uk");
  });

  it("lower-cases and collapses runs of non-alphanumeric characters to a single hyphen", () => {
    expect(slugify("Global   Visa & Tickets!!")).toBe("global-visa-tickets");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  --Airport Check-In--  ")).toBe("airport-check-in");
  });

  it("passes an already-clean kebab string through unchanged", () => {
    expect(slugify("tu-billing-uk")).toBe("tu-billing-uk");
  });

  it("returns an empty string for input with no alphanumeric characters", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("   ")).toBe("");
  });
});

describe("splitTotal", () => {
  it("sums the rollout percentages across variants", () => {
    const variants: VariantInput[] = [
      { key: "a", rolloutPercentage: 50, themeSlug: "x", isControl: true },
      { key: "b", rolloutPercentage: 50, themeSlug: "y", isControl: false },
    ];
    expect(splitTotal(variants)).toBe(100);
  });

  it("sums three unequal splits correctly", () => {
    const variants: VariantInput[] = [
      { key: "a", rolloutPercentage: 34, themeSlug: "x", isControl: true },
      { key: "b", rolloutPercentage: 33, themeSlug: "y", isControl: false },
      { key: "c", rolloutPercentage: 33, themeSlug: "z", isControl: false },
    ];
    expect(splitTotal(variants)).toBe(100);
  });

  it("returns 0 for an empty variant list", () => {
    expect(splitTotal([])).toBe(0);
  });

  it("is tolerant of a non-numeric rolloutPercentage (treats it as 0, not NaN)", () => {
    const variants = [
      { key: "a", rolloutPercentage: 60, themeSlug: "x", isControl: true },
      { key: "b", rolloutPercentage: undefined as unknown as number, themeSlug: "y", isControl: false },
    ];
    expect(splitTotal(variants)).toBe(60);
  });
});

describe("evenSplit", () => {
  it("splits two arms exactly in half", () => {
    expect(evenSplit(2)).toEqual([50, 50]);
  });

  it("puts the remainder on the leading arms (3 arms → 34/33/33)", () => {
    expect(evenSplit(3)).toEqual([34, 33, 33]);
  });

  it("splits four arms evenly", () => {
    expect(evenSplit(4)).toEqual([25, 25, 25, 25]);
  });

  it("always sums to exactly 100 — the value validateInput requires", () => {
    for (let n = 1; n <= 12; n++) {
      const split = evenSplit(n);
      expect(split).toHaveLength(n);
      expect(split.reduce((a, b) => a + b, 0)).toBe(100);
    }
  });

  it("a single arm takes the whole 100", () => {
    expect(evenSplit(1)).toEqual([100]);
  });

  it("returns [] for a non-positive or non-finite count", () => {
    expect(evenSplit(0)).toEqual([]);
    expect(evenSplit(-3)).toEqual([]);
    expect(evenSplit(Number.NaN)).toEqual([]);
  });

  it("produces a split that passes validateInput end-to-end", () => {
    const splits = evenSplit(3);
    const variants: VariantInput[] = [
      { key: "control", rolloutPercentage: splits[0]!, themeSlug: "tu_lov_uk", isControl: true },
      { key: "b", rolloutPercentage: splits[1]!, themeSlug: "tu_lov_uk", isControl: false },
      { key: "c", rolloutPercentage: splits[2]!, themeSlug: "tu_lov_uk", isControl: false },
    ];
    // A/A-style input (identical theme slugs, even split) — must validate.
    expect(validateInput({ ...validInput(), variants }, ALLOWED_GOAL_METRICS)).toBeNull();
  });
});

describe("composeExperimentName — the 4-part name schema", () => {
  it("joins all four parts in ID | business | what | page order, pipe-separated", () => {
    expect(
      composeExperimentName({
        uniqueId: "EXP001",
        business: "TU",
        what: "Reassurance Banner",
        page: "/recharge ads-flow",
      }),
    ).toBe("EXP001 | TU | Reassurance Banner | /recharge ads-flow");
  });

  it("skips blank / whitespace-only / missing parts rather than leaving empty segments", () => {
    expect(
      composeExperimentName({ uniqueId: "EXP001", business: "TU", what: "   ", page: "" }),
    ).toBe("EXP001 | TU");
    expect(composeExperimentName({ business: "PDF" })).toBe("PDF");
    expect(composeExperimentName({})).toBe("");
  });

  it("trims each part", () => {
    expect(composeExperimentName({ uniqueId: "  EXP002  ", what: "  copy test  " })).toBe(
      "EXP002 | copy test",
    );
  });
});

describe("keyFromIdOrName — key derives from the Unique ID, not the whole name", () => {
  it("slugs the Unique ID when present (short, stable key)", () => {
    expect(keyFromIdOrName("EXP001", "EXP001 | TU | £19 vs £39 | landing")).toBe("exp001");
  });

  it("falls back to slugging the name when there is no ID", () => {
    expect(keyFromIdOrName("", "Top Up Billing UK")).toBe("top-up-billing-uk");
    expect(keyFromIdOrName("   ", "Top Up Billing UK")).toBe("top-up-billing-uk");
  });

  it("falls back to the name when the ID has no sluggable characters", () => {
    expect(keyFromIdOrName("###", "Top Up Test")).toBe("top-up-test");
  });

  it("returns '' only when both ID and name are empty (validateInput then fails on name)", () => {
    expect(keyFromIdOrName("", "")).toBe("");
  });

  it("produces a key that passes validateInput's key rule", () => {
    const key = keyFromIdOrName("EXP001", "irrelevant");
    expect(validate(validInput({ key, name: "EXP001 | TU | x | y" }))).toBeNull();
  });
});

describe("businessCode — the short uppercase code for the name's business segment", () => {
  it("maps each known label to its YouTrack-aligned code", () => {
    expect(businessCode("Top Up")).toBe("TU");
    expect(businessCode("PDF SaaS")).toBe("PDF");
    expect(businessCode("Airport Check-In")).toBe("AC");
    expect(businessCode("Airport Security")).toBe("AS");
    expect(businessCode("Global Tickets")).toBe("GT");
    expect(businessCode("Gift Cards")).toBe("GC");
    expect(businessCode("Airport Lounges")).toBe("AL");
    expect(businessCode("Global Visa")).toBe("GV");
  });

  it("falls back to the raw value for an unknown / stale business", () => {
    expect(businessCode("Not A Business")).toBe("Not A Business");
  });
});

describe("nextExpId — a single running EXP counter across all experiments", () => {
  it("floors at EXP001 when nothing matches", () => {
    expect(nextExpId([])).toBe("EXP001");
    expect(nextExpId(["tu-billing-uk", "TU — Billing UK"])).toBe("EXP001");
  });

  it("returns max+1, zero-padded to three digits, scanning keys AND names", () => {
    expect(nextExpId(["exp001", "EXP002 | TU | x | y"])).toBe("EXP003");
    expect(nextExpId(["EXP009"])).toBe("EXP010");
    expect(nextExpId(["EXP099"])).toBe("EXP100");
  });

  it("is case-insensitive and ignores non-matching strings", () => {
    expect(nextExpId(["random", "exp007", "another"])).toBe("EXP008");
  });

  it("keeps counting past three digits without truncating", () => {
    expect(nextExpId(["EXP999"])).toBe("EXP1000");
  });
});

describe("isValidYoutrackTicket — bare ID or full URL", () => {
  it("accepts a bare issue ID", () => {
    expect(isValidYoutrackTicket("GP-603")).toBe(true);
    expect(isValidYoutrackTicket("GAPI-12")).toBe(true);
  });

  it("accepts a full http(s) URL", () => {
    expect(isValidYoutrackTicket("https://sanjow.youtrack.cloud/issue/GP-603")).toBe(true);
    expect(isValidYoutrackTicket("http://example.com/issue/GP-1")).toBe(true);
  });

  it("rejects a lower-case id, a bare number, or free text", () => {
    expect(isValidYoutrackTicket("gp-603")).toBe(false);
    expect(isValidYoutrackTicket("603")).toBe(false);
    expect(isValidYoutrackTicket("just some words")).toBe(false);
  });
});

describe("youtrackTicketHref — the detail-page link target", () => {
  const base = "https://sanjow.youtrack.cloud";

  it("resolves a bare ID against the base URL", () => {
    expect(youtrackTicketHref("GP-603", base)).toBe(
      "https://sanjow.youtrack.cloud/issue/GP-603",
    );
  });

  it("uses a full URL as-is", () => {
    const url = "https://other.youtrack.cloud/issue/AB-1";
    expect(youtrackTicketHref(url, base)).toBe(url);
  });

  it("tolerates a trailing slash on the base and trims the ticket", () => {
    expect(youtrackTicketHref("  GP-7  ", "https://sanjow.youtrack.cloud/")).toBe(
      "https://sanjow.youtrack.cloud/issue/GP-7",
    );
  });

  it("returns null for a blank ticket (link omitted)", () => {
    expect(youtrackTicketHref("", base)).toBeNull();
    expect(youtrackTicketHref("   ", base)).toBeNull();
  });
});

describe("validateInput — YouTrack ticket (optional, format-checked)", () => {
  it("accepts an omitted or blank ticket", () => {
    expect(validate(validInput())).toBeNull();
    expect(validate(validInput({ youtrackTicket: "" }))).toBeNull();
    expect(validate(validInput({ youtrackTicket: "   " }))).toBeNull();
  });

  it("accepts a bare ID or a full URL", () => {
    expect(validate(validInput({ youtrackTicket: "GP-603" }))).toBeNull();
    expect(
      validate(validInput({ youtrackTicket: "https://sanjow.youtrack.cloud/issue/GP-603" })),
    ).toBeNull();
  });

  it("rejects a malformed ticket", () => {
    expect(validate(validInput({ youtrackTicket: "not a ticket" }))).toBe(
      "YouTrack ticket must be an issue ID like GP-603, or a full ticket URL.",
    );
  });
});

describe("cloneName", () => {
  it("swaps the EXP id token, keeping the rest of the 4-part name", () => {
    expect(cloneName("EXP001 | TU | cheaper SKU | pricing page", "EXP007")).toBe(
      "EXP007 | TU | cheaper SKU | pricing page",
    );
  });

  it("matches the EXP id case-insensitively and swaps only the first occurrence", () => {
    expect(cloneName("exp1 | TU | rerun of EXP1", "EXP007")).toBe("EXP007 | TU | rerun of EXP1");
  });

  it("appends (copy) when the name carries no EXP id", () => {
    expect(cloneName("hand written name", "EXP007")).toBe("hand written name (copy)");
  });
});

describe("buildCloneInput", () => {
  const source: StoredExperiment = {
    key: "exp001",
    name: "EXP001 | TU | cheaper SKU | pricing",
    business: "Top Up",
    active: true,
    goalMetric: "auth_rate",
    startDate: "2026-09-01",
    description: "Cheaper SKU vs the default plan.",
    createdAt: "2026-09-01T00:00:00.000Z",
    rolloutPercentage: 100,
    variants: [
      { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
      { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
    ],
    controlVariant: "control",
    themeMap: { control: "tu_lov_uk", variant_19: "tu_lov_uk_19" },
    youtrackTicket: "GP-603",
  };

  it("allocates a fresh key + EXP id and recomposes the name", () => {
    const clone = buildCloneInput(source, "EXP007");
    expect(clone.name).toBe("EXP007 | TU | cheaper SKU | pricing");
    expect(clone.key).toBe("exp007");
  });

  it("clears the YouTrack ticket — a clone is a new test, not the source's ticket", () => {
    expect(buildCloneInput(source, "EXP007").youtrackTicket).toBe("");
  });

  it("forces the clone paused regardless of the source's active state", () => {
    expect(buildCloneInput(source, "EXP007").active).toBe(false);
    expect(buildCloneInput({ ...source, active: false }, "EXP007").active).toBe(false);
  });

  it("copies business, goal metric, start date, description and every variant verbatim", () => {
    const clone = buildCloneInput(source, "EXP007");
    expect(clone.business).toBe("Top Up");
    expect(clone.goalMetric).toBe("auth_rate");
    expect(clone.startDate).toBe("2026-09-01");
    expect(clone.description).toBe("Cheaper SKU vs the default plan.");
    expect(clone.variants).toEqual(source.variants);
  });

  it("omits an empty description (undefined, not an empty string)", () => {
    expect(buildCloneInput({ ...source, description: "" }, "EXP007").description).toBeUndefined();
  });

  it("gives the variant array a fresh identity (not the source's reference)", () => {
    const clone = buildCloneInput(source, "EXP007");
    expect(clone.variants).not.toBe(source.variants);
    expect(clone.variants[0]).not.toBe(source.variants[0]);
  });

  it("produces an input that passes validateInput (immediately valid)", () => {
    expect(validate(buildCloneInput(source, "EXP007"))).toBeNull();
  });
});
