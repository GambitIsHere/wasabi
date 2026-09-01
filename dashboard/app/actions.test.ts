// ============================================================================
// actions.ts — M2: createExperiment must not leak cross-tenant key existence
// through a raw Postgres error message.
// ----------------------------------------------------------------------------
// experiment.key is a GLOBAL primary key across tenants (lib/tenant.ts's
// KNOWN LIMITATION note), so experimentExists() only rules out a SAME-tenant
// duplicate before the INSERT runs. If a DIFFERENT tenant already owns the
// key, the INSERT hits that global constraint and Postgres throws a
// duplicate-key error naming it — which must NOT reach the caller verbatim
// (that would confirm another tenant owns the key). DB-touching deps
// (@/lib/authz, @/lib/metrics, @/lib/store, next/cache) are mocked — this
// codebase's DB-free unit-test convention (same vi.mock pattern as
// lib/authz.test.ts / lib/experiments.test.ts). @/lib/mgmt's validateInput
// and @/lib/users's isUniqueViolation are left REAL: this test exercises the
// actual validation + error-classification logic, not a stub of it.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/metrics", () => ({ getMetrics: vi.fn() }));
vi.mock("@/lib/store", () => ({
  deleteExperiment: vi.fn(),
  experimentExists: vi.fn(),
  getExperiment: vi.fn(),
  insertExperiment: vi.fn(),
  resolveKey: vi.fn(),
  setActive: vi.fn(),
  updateExperiment: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createExperiment } from "@/app/actions";
import { requireRole } from "@/lib/authz";
import { getMetrics } from "@/lib/metrics";
import { experimentExists, insertExperiment, resolveKey } from "@/lib/store";
import type { ExperimentInput } from "@/lib/mgmt";
import type { MetricDef } from "@/lib/metrics-core";

const mockRequireRole = vi.mocked(requireRole);
const mockGetMetrics = vi.mocked(getMetrics);
const mockExperimentExists = vi.mocked(experimentExists);
const mockInsertExperiment = vi.mocked(insertExperiment);
const mockResolveKey = vi.mocked(resolveKey);

function validInput(overrides: Partial<ExperimentInput> = {}): ExperimentInput {
  return {
    name: "TU Billing UK Test",
    business: "Top Up",
    goalMetric: "auth_rate",
    startDate: "2026-09-01",
    variants: [
      { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
      { key: "variant_19", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({ ok: true, userId: "u1", orgId: "sanjow", role: "editor" });
  mockGetMetrics.mockResolvedValue([{ key: "auth_rate", isGoal: true }] as unknown as MetricDef[]);
  mockResolveKey.mockReturnValue("tu-billing-uk-test");
});

describe("createExperiment — cross-tenant key collision (M2)", () => {
  it("genericises a Postgres unique-violation instead of echoing the raw message", async () => {
    mockExperimentExists.mockResolvedValue(false); // no SAME-tenant row — the pre-check passes
    mockInsertExperiment.mockRejectedValue({
      code: "23505",
      message:
        'duplicate key value violates unique constraint "experiment_pkey" (key)=(tu-billing-uk-test)',
    });

    const result = await createExperiment(validInput());

    expect(result).toEqual({
      ok: false,
      error: "That experiment key is already in use — pick another.",
    });
  });

  it("still genericises when the driver surfaces the violation with no .code, via the message fallback", async () => {
    mockExperimentExists.mockResolvedValue(false);
    mockInsertExperiment.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "experiment_pkey"'),
    );

    const result = await createExperiment(validInput());

    expect(result).toEqual({
      ok: false,
      error: "That experiment key is already in use — pick another.",
    });
  });

  it("does NOT genericise an unrelated failure — the real message still surfaces", async () => {
    mockExperimentExists.mockResolvedValue(false);
    mockInsertExperiment.mockRejectedValue(new Error("Neon connection timed out"));

    const result = await createExperiment(validInput());

    expect(result).toEqual({ ok: false, error: "Neon connection timed out" });
  });

  it("preserves the existing, informative SAME-tenant duplicate message (never reaches insertExperiment)", async () => {
    mockExperimentExists.mockResolvedValue(true); // THIS tenant already has the key

    const result = await createExperiment(validInput());

    expect(result).toEqual({
      ok: false,
      error: 'An experiment with key "tu-billing-uk-test" already exists. Pick a different name or key.',
    });
    expect(mockInsertExperiment).not.toHaveBeenCalled();
  });
});
