// ============================================================================
// actions.ts — completeExperiment / restoreExperiment: the load-bearing
// ORDERING and NO-DATA-LOSS invariants around the destructive delete.
// ----------------------------------------------------------------------------
// completeExperiment writes the archive BEFORE deleting the live row; a failed
// archive write must leave the live row intact. restoreExperiment inserts the
// live row BEFORE deleting the archived copy; a failed insert must leave the
// archive intact. It also pins the results-snapshot mapping (runResults +
// experimentWiring → the archived input's per-variant numbers).
//
// The pure builders (buildArchivedInputFromLive / buildRestoreInput) and
// ARCHIVED_STATUSES are left REAL via importActual — only the I/O functions
// (upsertArchived / getArchived / deleteArchived) are stubbed — so the snapshot
// mapping is exercised end to end into the ArchivedInput handed to upsertArchived.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/metrics", () => ({ getMetrics: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/metabase", () => ({ runResults: vi.fn() }));
vi.mock("@/lib/events", () => ({
  experimentWiring: vi.fn(),
  EMPTY_WIRING: { assignmentsToday: 0, assignmentsTotal: 0, capturesToday: 0, capturesTotal: 0, byArm: {} },
}));
vi.mock("@/lib/store", () => ({
  getExperiment: vi.fn(),
  deleteExperiment: vi.fn(),
  insertExperiment: vi.fn(),
  experimentExists: vi.fn(),
  resolveKey: vi.fn(),
  toRegistered: vi.fn((e) => e),
  // Unused here but imported by actions.ts — present so the mock is complete.
  listExperiments: vi.fn(),
  bulkDelete: vi.fn(),
  bulkSetActive: vi.fn(),
  setActive: vi.fn(),
  updateExperiment: vi.fn(),
}));
vi.mock("@/lib/archive", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/archive")>();
  return {
    ...actual,
    upsertArchived: vi.fn(),
    getArchived: vi.fn(),
    deleteArchived: vi.fn(),
    listArchived: vi.fn(),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { completeExperiment, restoreExperiment } from "@/app/actions";
import { requireRole } from "@/lib/authz";
import { runResults } from "@/lib/metabase";
import { experimentWiring } from "@/lib/events";
import {
  deleteArchived,
  getArchived,
  upsertArchived,
  type ArchivedExperiment,
} from "@/lib/archive";
import {
  deleteExperiment as storeDelete,
  experimentExists,
  getExperiment,
  insertExperiment,
  resolveKey,
} from "@/lib/store";
import type { StoredExperiment } from "@/lib/mgmt";

const mockRequireRole = vi.mocked(requireRole);
const mockRunResults = vi.mocked(runResults);
const mockWiring = vi.mocked(experimentWiring);
const mockUpsertArchived = vi.mocked(upsertArchived);
const mockGetArchived = vi.mocked(getArchived);
const mockDeleteArchived = vi.mocked(deleteArchived);
const mockStoreDelete = vi.mocked(storeDelete);
const mockExperimentExists = vi.mocked(experimentExists);
const mockGetExperiment = vi.mocked(getExperiment);
const mockInsertExperiment = vi.mocked(insertExperiment);
const mockResolveKey = vi.mocked(resolveKey);

function liveExp(overrides: Partial<StoredExperiment> = {}): StoredExperiment {
  return {
    key: "exp042",
    name: "EXP042 | TU | cheaper SKU | pricing",
    business: "Top Up",
    active: true,
    goalMetric: "auth_rate",
    startDate: "2026-08-01",
    description: "",
    createdAt: "2026-08-01T00:00:00.000Z",
    rolloutPercentage: 100,
    variants: [
      { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
      { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
    ],
    controlVariant: "control",
    themeMap: { control: "tu_lov_uk", variant_19: "tu_lov_uk_19" },
    youtrackTicket: "",
    ...overrides,
  };
}

function archivedExp(overrides: Partial<ArchivedExperiment> = {}): ArchivedExperiment {
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
    visitorsTotal: 0,
    conversionsTotal: 0,
    hypothesis: "",
    notes: "",
    insight: "",
    importedAt: "2026-09-08T00:00:00.000Z",
    variants: [
      { key: "control", name: "control", isControl: true, themeSlug: "tu_lov_uk", visitors: 0, conversions: 0, conversionRate: 0, improvement: null, chanceToBeat: null, position: 0, authRate: null, rebillR1: null, rebillR2: null, rebillR3: null, netRevPerAcquired: null },
      { key: "variant_19", name: "variant_19", isControl: false, themeSlug: "tu_lov_uk_19", visitors: 0, conversions: 0, conversionRate: 0, improvement: null, chanceToBeat: null, position: 1, authRate: null, rebillR1: null, rebillR2: null, rebillR3: null, netRevPerAcquired: null },
    ],
    ...overrides,
  };
}

const EMPTY_WIRING_VAL = { assignmentsToday: 0, assignmentsTotal: 0, capturesToday: 0, capturesTotal: 0, byArm: {} };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({ ok: true, userId: "u1", orgId: "sanjow", role: "editor" });
  mockWiring.mockResolvedValue(EMPTY_WIRING_VAL);
  mockRunResults.mockResolvedValue({ available: false, reason: "local" });
  mockResolveKey.mockImplementation((i) => (i.key && i.key.trim()) || "");
});

describe("completeExperiment — archive BEFORE delete (no data loss)", () => {
  it("archives first, then deletes the live row, and returns the archived key", async () => {
    mockGetExperiment.mockResolvedValue(liveExp());
    mockUpsertArchived.mockResolvedValue("exp042");
    mockStoreDelete.mockResolvedValue(true);

    const res = await completeExperiment("exp042", { winnerVariant: "variant_19", status: "winner", notes: "ship it" });

    expect(res).toEqual({ ok: true, key: "exp042" });
    expect(mockUpsertArchived).toHaveBeenCalledTimes(1);
    expect(mockStoreDelete).toHaveBeenCalledWith("exp042");
    // Ordering: the archive write must precede the live delete.
    expect(mockUpsertArchived.mock.invocationCallOrder[0]).toBeLessThan(
      mockStoreDelete.mock.invocationCallOrder[0],
    );
  });

  it("does NOT delete the live row when the archive write throws", async () => {
    mockGetExperiment.mockResolvedValue(liveExp());
    mockUpsertArchived.mockRejectedValue(new Error("Neon connection timed out"));

    const res = await completeExperiment("exp042", { winnerVariant: "control", status: "lost" });

    expect(res.ok).toBe(false);
    expect(mockStoreDelete).not.toHaveBeenCalled();
  });

  it("404s an unknown key without touching the archive or the live row", async () => {
    mockGetExperiment.mockResolvedValue(undefined);

    const res = await completeExperiment("ghost", { winnerVariant: "control", status: "winner" });

    expect(res).toEqual({ ok: false, error: 'No experiment with key "ghost".' });
    expect(mockUpsertArchived).not.toHaveBeenCalled();
    expect(mockStoreDelete).not.toHaveBeenCalled();
  });

  it("rejects a winner that isn't one of the experiment's variants", async () => {
    mockGetExperiment.mockResolvedValue(liveExp());

    const res = await completeExperiment("exp042", { winnerVariant: "not_a_variant", status: "winner" });

    expect(res.ok).toBe(false);
    expect(mockUpsertArchived).not.toHaveBeenCalled();
    expect(mockStoreDelete).not.toHaveBeenCalled();
  });

  it("rejects a status outside the archived-status set", async () => {
    mockGetExperiment.mockResolvedValue(liveExp());

    const res = await completeExperiment("exp042", {
      winnerVariant: "control",
      status: "bogus" as unknown as "winner",
    });

    expect(res.ok).toBe(false);
    expect(mockUpsertArchived).not.toHaveBeenCalled();
  });

  it("is refused for a non-editor, touching nothing", async () => {
    mockRequireRole.mockResolvedValue({ ok: false, status: 403, error: "nope" });

    const res = await completeExperiment("exp042", { winnerVariant: "control", status: "winner" });

    expect(res).toEqual({ ok: false, error: "nope" });
    expect(mockGetExperiment).not.toHaveBeenCalled();
    expect(mockUpsertArchived).not.toHaveBeenCalled();
  });
});

describe("completeExperiment — results snapshot mapping into the archived input", () => {
  it("prefers Metabase runResults numbers, mapping appsAcquired/firstPaid/rebillRate/net-rev-per-acquired onto the archive", async () => {
    mockGetExperiment.mockResolvedValue(liveExp());
    mockUpsertArchived.mockResolvedValue("exp042");
    mockStoreDelete.mockResolvedValue(true);
    // Wiring gives baseline counts; runResults overrides them + adds payment.
    mockWiring.mockResolvedValue({
      ...EMPTY_WIRING_VAL,
      byArm: {
        control: { assignmentsToday: 0, assignmentsTotal: 900, capturesToday: 0, capturesTotal: 90 },
        variant_19: { assignmentsToday: 0, assignmentsTotal: 950, capturesToday: 0, capturesTotal: 130 },
      },
    });
    mockRunResults.mockResolvedValue({
      available: true,
      rows: [
        { variant: "control", themeSlug: "tu_lov_uk", isControl: true, appsAcquired: 1000, firstPaid: 120, firstFailed: 20, authRate: 85.7, rebillOk: 0, rebillFail: 0, rebillRate: 60.5, revenueGbp: 0, revPerAcquired: 12.1, netRevenueGbp: 11000, breakEvenCacGbp: 9.8 },
        { variant: "variant_19", themeSlug: "tu_lov_uk_19", isControl: false, appsAcquired: 1010, firstPaid: 160, firstFailed: 10, authRate: 94.1, rebillOk: 0, rebillFail: 0, rebillRate: 66.0, revenueGbp: 0, revPerAcquired: 15.4, netRevenueGbp: 14140, breakEvenCacGbp: 13.2 },
      ],
    });

    await completeExperiment("exp042", { winnerVariant: "variant_19", status: "winner" });

    const input = mockUpsertArchived.mock.calls[0][0];
    const control = input.variants.find((v) => v.key === "control")!;
    const variant = input.variants.find((v) => v.key === "variant_19")!;

    // runResults wins over the wiring counts (appsAcquired/firstPaid, not 900/90).
    expect(control.visitors).toBe(1000);
    expect(control.conversions).toBe(120);
    expect(control.authRate).toBe(85.7);
    expect(control.rebillR1).toBe(60.5); // aggregate rebillRate carried on R1
    expect(control.netRevPerAcquired).toBe(11); // netRevenueGbp/appsAcquired (11000/1000), NOT breakEvenCacGbp (9.8)
    expect(variant.visitors).toBe(1010);
    expect(variant.netRevPerAcquired).toBe(14); // 14140/1010, NOT breakEvenCacGbp (13.2)
  });

  it("falls back to wiring counts (visitors=assignments, conversions=captures) when Metabase is unavailable", async () => {
    mockGetExperiment.mockResolvedValue(liveExp());
    mockUpsertArchived.mockResolvedValue("exp042");
    mockStoreDelete.mockResolvedValue(true);
    mockWiring.mockResolvedValue({
      ...EMPTY_WIRING_VAL,
      byArm: {
        control: { assignmentsToday: 0, assignmentsTotal: 900, capturesToday: 0, capturesTotal: 90 },
        variant_19: { assignmentsToday: 0, assignmentsTotal: 950, capturesToday: 0, capturesTotal: 130 },
      },
    });
    mockRunResults.mockResolvedValue({ available: false, reason: "METABASE_API_KEY not configured" });

    await completeExperiment("exp042", { winnerVariant: "variant_19", status: "winner" });

    const input = mockUpsertArchived.mock.calls[0][0];
    const control = input.variants.find((v) => v.key === "control")!;
    expect(control.visitors).toBe(900);
    expect(control.conversions).toBe(90);
    expect(control.authRate).toBeUndefined(); // no payment read locally
  });
});

describe("restoreExperiment — insert BEFORE delete (no data loss)", () => {
  it("inserts the live row first, then deletes the archived copy, and returns the live key", async () => {
    mockGetArchived.mockResolvedValue(archivedExp());
    mockExperimentExists.mockResolvedValue(false);
    mockInsertExperiment.mockResolvedValue("exp042");
    mockDeleteArchived.mockResolvedValue(true);

    const res = await restoreExperiment("exp042");

    expect(res).toEqual({ ok: true, key: "exp042" });
    expect(mockInsertExperiment.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteArchived.mock.invocationCallOrder[0],
    );
    // The live insert carries the rebuilt PAUSED input.
    expect(mockInsertExperiment.mock.calls[0][0]).toMatchObject({ key: "exp042", active: false });
  });

  it("does NOT delete the archived copy when the live insert throws", async () => {
    mockGetArchived.mockResolvedValue(archivedExp());
    mockExperimentExists.mockResolvedValue(false);
    mockInsertExperiment.mockRejectedValue(new Error("Neon connection timed out"));

    const res = await restoreExperiment("exp042");

    expect(res.ok).toBe(false);
    expect(mockDeleteArchived).not.toHaveBeenCalled();
  });

  it("refuses to clobber a live experiment that already holds the key", async () => {
    mockGetArchived.mockResolvedValue(archivedExp());
    mockExperimentExists.mockResolvedValue(true);

    const res = await restoreExperiment("exp042");

    expect(res.ok).toBe(false);
    expect(mockInsertExperiment).not.toHaveBeenCalled();
    expect(mockDeleteArchived).not.toHaveBeenCalled();
  });

  it("404s an unknown archived key", async () => {
    mockGetArchived.mockResolvedValue(undefined);

    const res = await restoreExperiment("ghost");

    expect(res).toEqual({ ok: false, error: 'No archived experiment with key "ghost".' });
    expect(mockInsertExperiment).not.toHaveBeenCalled();
  });

  it("is refused for a non-editor, touching nothing", async () => {
    mockRequireRole.mockResolvedValue({ ok: false, status: 403, error: "nope" });

    const res = await restoreExperiment("exp042");

    expect(res).toEqual({ ok: false, error: "nope" });
    expect(mockGetArchived).not.toHaveBeenCalled();
    expect(mockInsertExperiment).not.toHaveBeenCalled();
  });
});
