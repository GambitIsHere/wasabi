// ============================================================================
// archive.ts — the live⇄archive bridge: the two PURE builders
// (buildArchivedInputFromLive, buildRestoreInput) plus a store-level round-trip
// proving the new theme_slug column survives upsert → getArchived.
// ----------------------------------------------------------------------------
// The builders are pure (no I/O), so they need no DB — but importing
// @/lib/archive pulls in @/lib/db and @/lib/tenant at module load, so those are
// mocked with the same minimal-fake-`sql` convention as lib/archive.test.ts /
// lib/store.test.ts. @/lib/mgmt (validateInput, evenSplit, slugify) is left REAL
// so the restore builder is proven to produce a genuinely valid ExperimentInput.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ createSchema: vi.fn(), getSql: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getCurrentProjectId: vi.fn() }));

import { createSchema, getSql } from "@/lib/db";
import { getCurrentProjectId } from "@/lib/tenant";
import {
  buildArchivedInputFromLive,
  buildRestoreInput,
  getArchived,
  upsertArchived,
  type ArchivedExperiment,
  type LiveResultsSnapshot,
} from "@/lib/archive";
import { validateInput } from "@/lib/mgmt";
import type { StoredExperiment } from "@/lib/mgmt";

const mockCreateSchema = vi.mocked(createSchema);
const mockGetSql = vi.mocked(getSql);
const mockGetCurrentProjectId = vi.mocked(getCurrentProjectId);

/** A realistic goal-metric allow-list for the validateInput round-trip. */
const ALLOWED_GOAL_METRICS = ["auth_rate", "rebill_rate", "rev_per_acquired", "apps_acquired"];

/** A fully-populated live experiment — the source of a native completion. */
function liveExp(overrides: Partial<StoredExperiment> = {}): StoredExperiment {
  return {
    key: "exp042",
    name: "EXP042 | TU | cheaper SKU | pricing",
    business: "Top Up",
    active: true,
    goalMetric: "auth_rate",
    startDate: "2026-08-01",
    description: "£19 vs the default £39 SKU.",
    createdAt: "2026-08-01T00:00:00.000Z",
    rolloutPercentage: 100,
    variants: [
      { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
      { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
    ],
    controlVariant: "control",
    themeMap: { control: "tu_lov_uk", variant_19: "tu_lov_uk_19" },
    youtrackTicket: "GP-603",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildArchivedInputFromLive
// ---------------------------------------------------------------------------

describe("buildArchivedInputFromLive", () => {
  const snapshot: LiveResultsSnapshot = {
    byVariant: {
      control: { visitors: 1000, conversions: 120, authRate: 82.4, rebillR1: 61.2, netRevPerAcquired: 14.5 },
      variant_19: { visitors: 1010, conversions: 150, authRate: 88.1, rebillR1: 64.0, netRevPerAcquired: 17.9 },
    },
  };

  it("carries the winner, status, notes and end date, and stamps a native source", () => {
    const input = buildArchivedInputFromLive(liveExp(), snapshot, {
      winnerVariant: "variant_19",
      status: "winner",
      notes: "Cheaper SKU lifted auth and rebill.",
      endDate: "2026-09-08",
    });

    expect(input.winnerVariant).toBe("variant_19");
    expect(input.status).toBe("winner");
    expect(input.notes).toBe("Cheaper SKU lifted auth and rebill.");
    expect(input.endDate).toBe("2026-09-08");
    expect(input.source).toBe("wasabi");
    expect(input.type).toBeNull();
  });

  it("copies key, name, business, goal metric and start date from the live experiment", () => {
    const input = buildArchivedInputFromLive(liveExp(), snapshot, {
      winnerVariant: "control",
      status: "lost",
      endDate: "2026-09-08",
    });

    expect(input.key).toBe("exp042");
    expect(input.name).toBe("EXP042 | TU | cheaper SKU | pricing");
    expect(input.business).toBe("Top Up");
    expect(input.goalMetric).toBe("auth_rate");
    expect(input.startDate).toBe("2026-08-01");
  });

  it("defaults notes to null when omitted", () => {
    const input = buildArchivedInputFromLive(liveExp(), snapshot, {
      winnerVariant: "control",
      status: "inconclusive",
      endDate: "2026-09-08",
    });
    expect(input.notes).toBeNull();
  });

  it("maps each live variant's theme slug, control flag and snapshot numbers by key", () => {
    const input = buildArchivedInputFromLive(liveExp(), snapshot, {
      winnerVariant: "variant_19",
      status: "winner",
      endDate: "2026-09-08",
    });

    const control = input.variants.find((v) => v.key === "control")!;
    const variant = input.variants.find((v) => v.key === "variant_19")!;

    expect(control.themeSlug).toBe("tu_lov_uk");
    expect(control.isControl).toBe(true);
    expect(control.visitors).toBe(1000);
    expect(control.conversions).toBe(120);
    expect(control.authRate).toBe(82.4);
    expect(control.rebillR1).toBe(61.2);
    expect(control.netRevPerAcquired).toBe(14.5);

    expect(variant.themeSlug).toBe("tu_lov_uk_19");
    expect(variant.isControl).toBe(false);
    expect(variant.authRate).toBe(88.1);
  });

  it("leaves numbers unset for a variant missing from the snapshot (normalize reads them as 0/null)", () => {
    // Only `control` is in the snapshot; `variant_19` is absent.
    const partial: LiveResultsSnapshot = { byVariant: { control: { visitors: 500 } } };
    const input = buildArchivedInputFromLive(liveExp(), partial, {
      winnerVariant: "control",
      status: "winner",
      endDate: "2026-09-08",
    });

    const variant = input.variants.find((v) => v.key === "variant_19")!;
    expect(variant.visitors).toBeUndefined();
    expect(variant.conversions).toBeUndefined();
    expect(variant.authRate).toBeUndefined();
    expect(variant.netRevPerAcquired).toBeUndefined();
    // Its theme slug + control flag still come from the live variant, not the snapshot.
    expect(variant.themeSlug).toBe("tu_lov_uk_19");
    expect(variant.isControl).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildRestoreInput
// ---------------------------------------------------------------------------

/** A minimal archived run — a native completion by default (real theme slugs). */
function archived(overrides: Partial<ArchivedExperiment> = {}): ArchivedExperiment {
  return {
    key: "exp042",
    name: "EXP042 | TU | cheaper SKU | pricing",
    business: "Top Up",
    source: "wasabi",
    sourceId: null,
    sourceUrl: null,
    type: null,
    status: "winner",
    goalMetric: "auth_rate",
    startDate: "2026-08-01",
    endDate: "2026-09-08",
    winnerVariant: "variant_19",
    visitorsTotal: 2010,
    conversionsTotal: 270,
    hypothesis: "",
    notes: "",
    insight: "",
    importedAt: "2026-09-08T00:00:00.000Z",
    variants: [
      variant("control", { isControl: true, themeSlug: "tu_lov_uk" }),
      variant("variant_19", { isControl: false, themeSlug: "tu_lov_uk_19" }),
    ],
    ...overrides,
  };
}

function variant(key: string, o: Partial<ArchivedExperiment["variants"][number]>): ArchivedExperiment["variants"][number] {
  return {
    key,
    name: key,
    isControl: false,
    themeSlug: null,
    visitors: 0,
    conversions: 0,
    conversionRate: 0,
    improvement: null,
    chanceToBeat: null,
    position: 0,
    authRate: null,
    rebillR1: null,
    rebillR2: null,
    rebillR3: null,
    netRevPerAcquired: null,
    ...o,
  };
}

describe("buildRestoreInput", () => {
  it("restores PAUSED, keeping the same key", () => {
    const input = buildRestoreInput(archived());
    expect(input.active).toBe(false);
    expect(input.key).toBe("exp042");
  });

  it("preserves each variant's theme slug from the archive", () => {
    const input = buildRestoreInput(archived());
    expect(input.variants.map((v) => v.themeSlug)).toEqual(["tu_lov_uk", "tu_lov_uk_19"]);
  });

  it("falls back to the variant key as the theme slug when the archive kept none (a VWO import)", () => {
    const vwo = archived({
      source: "vwo",
      variants: [
        variant("control", { isControl: true, themeSlug: null }),
        variant("challenger", { isControl: false, themeSlug: null }),
      ],
    });
    const input = buildRestoreInput(vwo);
    expect(input.variants.map((v) => v.themeSlug)).toEqual(["control", "challenger"]);
  });

  it("distributes an even split that sums to exactly 100", () => {
    const three = archived({
      variants: [
        variant("control", { isControl: true, themeSlug: "tu_lov_uk" }),
        variant("b", { themeSlug: "tu_lov_uk_19" }),
        variant("c", { themeSlug: "tu_lov_uk_39" }),
      ],
    });
    const input = buildRestoreInput(three);
    expect(input.variants.map((v) => v.rolloutPercentage)).toEqual([34, 33, 33]);
    expect(input.variants.reduce((s, v) => s + v.rolloutPercentage, 0)).toBe(100);
  });

  it("keeps exactly one control — the one the archive marked", () => {
    const input = buildRestoreInput(archived());
    expect(input.variants.filter((v) => v.isControl)).toHaveLength(1);
    expect(input.variants.find((v) => v.isControl)!.key).toBe("control");
  });

  it("makes the first arm the control when the archive marked none", () => {
    const noControl = archived({
      variants: [
        variant("a", { isControl: false, themeSlug: "tu_lov_uk" }),
        variant("b", { isControl: false, themeSlug: "tu_lov_uk_19" }),
      ],
    });
    const input = buildRestoreInput(noControl);
    expect(input.variants.filter((v) => v.isControl)).toHaveLength(1);
    expect(input.variants[0].isControl).toBe(true);
  });

  it("collapses multiple archived controls down to exactly one (the first)", () => {
    const twoControls = archived({
      variants: [
        variant("a", { isControl: true, themeSlug: "tu_lov_uk" }),
        variant("b", { isControl: true, themeSlug: "tu_lov_uk_19" }),
      ],
    });
    const input = buildRestoreInput(twoControls);
    expect(input.variants.filter((v) => v.isControl)).toHaveLength(1);
    expect(input.variants[0].isControl).toBe(true);
  });

  it("produces an ExperimentInput that passes validateInput (a valid live test)", () => {
    expect(validateInput(buildRestoreInput(archived()), ALLOWED_GOAL_METRICS)).toBeNull();
  });

  it("passes validateInput for a 3-arm VWO import with key-as-slug fallback", () => {
    // Variant keys are ≥2 chars (as real ones are), so the key-as-slug fallback
    // clears THEME_SLUG_RE's 2-char minimum.
    const vwo = archived({
      source: "vwo",
      goalMetric: "rev_per_acquired",
      variants: [
        variant("baseline", { isControl: false, themeSlug: null }),
        variant("challenger", { isControl: false, themeSlug: null }),
        variant("bold", { isControl: false, themeSlug: null }),
      ],
    });
    expect(validateInput(buildRestoreInput(vwo), ALLOWED_GOAL_METRICS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Store round-trip — theme_slug survives upsertArchived → getArchived.
// A stateful fake `sql`: writes captured during upsert's transaction are read
// back by getArchived's SELECTs, so the new column is exercised end to end.
// ---------------------------------------------------------------------------

type FakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => unknown) & {
  transaction: (queries: unknown[]) => Promise<unknown>;
};

function statefulSql(projectId: string): ReturnType<typeof getSql> {
  let expRows: Record<string, unknown>[] = [];
  let varRows: Record<string, unknown>[] = [];

  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ").trim();
    if (/^DELETE FROM archived_experiment/i.test(text)) {
      const key = values[0];
      expRows = expRows.filter((r) => !(r.key === key && r.project_id === values[1]));
      varRows = varRows.filter((r) => r.archived_key !== key);
      return Promise.resolve([]);
    }
    if (/^INSERT INTO archived_experiment/i.test(text)) {
      expRows.push({
        key: values[0], name: values[1], business: values[2], source: values[3],
        source_id: values[4], source_url: values[5], type: values[6], status: values[7],
        goal_metric: values[8], start_date: values[9], end_date: values[10], winner_variant: values[11],
        visitors_total: values[12], conversions_total: values[13], hypothesis: values[14],
        notes: values[15], insight: values[16], imported_at: values[17], project_id: values[18],
      });
      return Promise.resolve([]);
    }
    if (/^INSERT INTO archived_variant/i.test(text)) {
      varRows.push({
        archived_key: values[0], key: values[1], name: values[2], is_control: values[3],
        theme_slug: values[4], visitors: values[5], conversions: values[6], conversion_rate: values[7],
        improvement: values[8], chance_to_beat: values[9], position: values[10],
        auth_rate: values[11], rebill_r1: values[12], rebill_r2: values[13], rebill_r3: values[14],
        net_rev_per_acquired: values[15],
      });
      return Promise.resolve([]);
    }
    if (/^SELECT \* FROM archived_experiment/i.test(text)) {
      return Promise.resolve(expRows.filter((r) => r.key === values[0] && r.project_id === values[1]));
    }
    if (/^SELECT \* FROM archived_variant/i.test(text)) {
      return Promise.resolve(
        varRows
          .filter((r) => r.archived_key === values[0])
          .sort((a, b) => (a.position as number) - (b.position as number)),
      );
    }
    return Promise.resolve([]);
  }) as FakeSql;
  fn.transaction = (queries: unknown[]) => Promise.all(queries as Promise<unknown>[]);
  void projectId;
  return fn as unknown as ReturnType<typeof getSql>;
}

describe("theme_slug round-trip — upsertArchived → getArchived", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSchema.mockResolvedValue(undefined);
    mockGetCurrentProjectId.mockResolvedValue("proj-1");
    mockGetSql.mockReturnValue(statefulSql("proj-1"));
  });

  it("persists a native completion's theme slugs and reads them back", async () => {
    const input = buildArchivedInputFromLive(liveExp(), { byVariant: {} }, {
      winnerVariant: "variant_19",
      status: "winner",
      endDate: "2026-09-08",
    });

    await upsertArchived(input);
    const read = await getArchived("exp042");

    expect(read).toBeDefined();
    expect(read!.variants.find((v) => v.key === "control")!.themeSlug).toBe("tu_lov_uk");
    expect(read!.variants.find((v) => v.key === "variant_19")!.themeSlug).toBe("tu_lov_uk_19");
  });

  it("reads back null for a VWO import that carried no theme slug", async () => {
    await upsertArchived({
      key: "vwo-1",
      name: "Legacy VWO campaign",
      business: "Top Up",
      source: "vwo",
      variants: [
        { key: "control", isControl: true, visitors: 100, conversions: 10 },
        { key: "challenger", isControl: false, visitors: 100, conversions: 14 },
      ],
    });
    const read = await getArchived("vwo-1");

    expect(read).toBeDefined();
    expect(read!.variants.every((v) => v.themeSlug === null)).toBe(true);
  });
});
