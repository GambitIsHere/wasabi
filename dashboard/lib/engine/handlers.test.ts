// ============================================================================
// engine/handlers.ts — C2: the /decide + /flags assignment-registry cache must
// be keyed PER TENANT, never a single module-level slot.
// ----------------------------------------------------------------------------
// getExperiments() is tenant-scoped (lib/store.ts filters by
// getCurrentProjectId). The old cache was one shared slot, so on a warm
// instance the FIRST tenant to hit /decide or /flags poisoned it for every
// other tenant for the 10s TTL — leaking one brand's experiment/variant/theme
// config to anonymous callers and mis-assigning their visitors. These tests
// pin the fix: distinct projects get distinct data, and a warm project is
// served from cache without re-reading the store. getExperiments + the tenant
// seam are mocked (this codebase's DB-free unit-test convention).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/experiments", () => ({ getExperiments: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getCurrentProjectId: vi.fn() }));

import { getExperiments } from "@/lib/experiments";
import { getCurrentProjectId } from "@/lib/tenant";
import type { RegisteredExperiment } from "@/lib/experiments";
import { handleFlags } from "@/lib/engine/handlers";

const mockGetExperiments = vi.mocked(getExperiments);
const mockGetCurrentProjectId = vi.mocked(getCurrentProjectId);

/** Minimal RegisteredExperiment — handleFlags only reads flag.key/active/variants. */
function exp(key: string): RegisteredExperiment {
  return {
    flag: { key, active: true, variants: [{ key: "control" }, { key: "v1" }] },
  } as unknown as RegisteredExperiment;
}

function flagKeys(res: { flags: Array<{ key: string }> }): string[] {
  return res.flags.map((f) => f.key);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assignmentRegistry cache (via handleFlags) — per-tenant isolation (C2)", () => {
  it("serves each project its OWN experiments, never another project's, and caches per project", async () => {
    // Two tenants, each with their own experiment set. Unique project ids so
    // this test can't collide with the module-level cache from another test.
    mockGetCurrentProjectId.mockResolvedValue("c2-proj-a");
    mockGetExperiments.mockResolvedValue([exp("exp-a1"), exp("exp-a2")]);

    // Cold: project A reads the store once.
    expect(flagKeys(await handleFlags())).toEqual(["exp-a1", "exp-a2"]);
    expect(mockGetExperiments).toHaveBeenCalledTimes(1);

    // Warm: same project served from cache — no second store read.
    expect(flagKeys(await handleFlags())).toEqual(["exp-a1", "exp-a2"]);
    expect(mockGetExperiments).toHaveBeenCalledTimes(1);

    // Switch tenant: project B must get B's data (NOT A's cached data), and it
    // reads the store because its own slot is cold.
    mockGetCurrentProjectId.mockResolvedValue("c2-proj-b");
    mockGetExperiments.mockResolvedValue([exp("exp-b1")]);
    expect(flagKeys(await handleFlags())).toEqual(["exp-b1"]);
    expect(mockGetExperiments).toHaveBeenCalledTimes(2);

    // Back to A: still cached from the first read — the two tenants' slots
    // coexist, neither overwrote the other.
    mockGetCurrentProjectId.mockResolvedValue("c2-proj-a");
    mockGetExperiments.mockResolvedValue([exp("SHOULD-NOT-BE-READ")]);
    expect(flagKeys(await handleFlags())).toEqual(["exp-a1", "exp-a2"]);
    expect(mockGetExperiments).toHaveBeenCalledTimes(2); // A was NOT re-read
  });

  it("resolves the projectId BEFORE reading experiments (so the read is always tenant-scoped)", async () => {
    mockGetCurrentProjectId.mockResolvedValue("c2-proj-order");
    mockGetExperiments.mockResolvedValue([exp("x")]);

    await handleFlags();

    expect(mockGetCurrentProjectId).toHaveBeenCalled();
  });
});
