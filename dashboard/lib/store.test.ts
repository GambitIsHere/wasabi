// ============================================================================
// store.ts — bulkSetActive / bulkDelete: the {changed, failed} aggregation.
// ----------------------------------------------------------------------------
// The bulk ops iterate the existing tenant-scoped single ops (setActive /
// deleteExperiment) with per-key isolation, so one key that matches no row —
// missing, or owned by another tenant — lands in failed[] while the rest still
// go through. These tests pin exactly that partial-failure contract.
//
// DB-touching deps (@/lib/db, @/lib/tenant) are mocked with a minimal fake
// `sql` client — this codebase's DB-free unit-test convention, same vi.mock
// pattern as lib/archive.test.ts. The REAL bulk + single-op logic runs end to
// end down to the actual `sql\`…\`` calls, where the per-key result is injected.
//
// The fake is intentionally driven by the interpolated key rather than by call
// order: store.ts memoises a one-time readiness pass (ensureReady → a COUNT),
// which the fake answers with a non-empty count so seeding never runs. Making
// the fake stateless-by-key keeps every test independent of that memoisation.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  createSchema: vi.fn(),
  getSql: vi.fn(),
}));
vi.mock("@/lib/tenant", () => ({ getCurrentProjectId: vi.fn() }));

import { createSchema, getSql } from "@/lib/db";
import { getCurrentProjectId } from "@/lib/tenant";
import { bulkDelete, bulkSetActive } from "@/lib/store";

const mockCreateSchema = vi.mocked(createSchema);
const mockGetSql = vi.mocked(getSql);
const mockGetCurrentProjectId = vi.mocked(getCurrentProjectId);

/** The minimal shape the store actually uses: a callable tagged-template plus a
 *  `.transaction()` method. Cast to the driver's real return type at the call
 *  site — the rest of NeonQueryFunction's surface is never touched here. */
type FakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => unknown) & {
  transaction: (queries: unknown[]) => Promise<unknown>;
};

/**
 * A fake `sql` whose UPDATE/DELETE result is decided by the experiment key it
 * was called with:
 *   - `owned`   — a row exists in this tenant → RETURNING key yields [{key}] → true
 *   - `errors`  — the driver rejects for this key (a synthetic DB fault)
 *   - anything else → [] → false (missing / another tenant's row)
 * The one-time readiness COUNT is answered non-empty so initOnce short-circuits
 * before it can seed.
 */
function fakeSql(opts: { owned?: Iterable<string>; errors?: Map<string, Error> }): ReturnType<typeof getSql> {
  const owned = new Set(opts.owned ?? []);
  const errors = opts.errors ?? new Map<string, Error>();
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    if (/count\(/i.test(text)) return Promise.resolve([{ n: 1 }]); // readiness: already seeded
    let key: string | null = null;
    if (/UPDATE\s+experiment/i.test(text)) key = String(values[1]); // SET active, WHERE key, project_id
    else if (/DELETE\s+FROM\s+experiment/i.test(text)) key = String(values[0]); // WHERE key, project_id
    if (key === null) return Promise.resolve([]);
    const err = errors.get(key);
    if (err) return Promise.reject(err);
    return Promise.resolve(owned.has(key) ? [{ key }] : []);
  }) as FakeSql;
  fn.transaction = (queries: unknown[]) => Promise.all(queries as Promise<unknown>[]);
  return fn as unknown as ReturnType<typeof getSql>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateSchema.mockResolvedValue(undefined);
  mockGetCurrentProjectId.mockResolvedValue("proj-1");
});

describe("bulkSetActive — {changed, failed} aggregation", () => {
  it("all keys owned → every key in changed, nothing failed", async () => {
    mockGetSql.mockReturnValue(fakeSql({ owned: ["a", "b", "c"] }));

    const result = await bulkSetActive(["a", "b", "c"], false);

    expect(result).toEqual({ changed: ["a", "b", "c"], failed: [] });
  });

  it("a missing / not-owned key lands in failed while the others still change", async () => {
    // "ghost" matches no row in this tenant (missing, or another tenant's).
    mockGetSql.mockReturnValue(fakeSql({ owned: ["a", "c"] }));

    const result = await bulkSetActive(["a", "ghost", "c"], true);

    expect(result.changed).toEqual(["a", "c"]);
    expect(result.failed).toEqual([{ key: "ghost", error: 'No experiment with key "ghost".' }]);
  });

  it("a thrown DB fault on one key is captured in failed, not propagated", async () => {
    mockGetSql.mockReturnValue(
      fakeSql({ owned: ["a", "b"], errors: new Map([["b", new Error("Neon connection timed out")]]) }),
    );

    const result = await bulkSetActive(["a", "b"], false);

    expect(result.changed).toEqual(["a"]);
    expect(result.failed).toEqual([{ key: "b", error: "Neon connection timed out" }]);
  });

  it("an empty keys array is a no-op — {changed:[], failed:[]}, no DB touched", async () => {
    const result = await bulkSetActive([], true);

    expect(result).toEqual({ changed: [], failed: [] });
    expect(mockGetSql).not.toHaveBeenCalled();
    expect(mockGetCurrentProjectId).not.toHaveBeenCalled();
  });
});

describe("bulkDelete — {changed, failed} aggregation", () => {
  it("all keys owned → every key in changed, nothing failed", async () => {
    mockGetSql.mockReturnValue(fakeSql({ owned: ["x", "y"] }));

    const result = await bulkDelete(["x", "y"]);

    expect(result).toEqual({ changed: ["x", "y"], failed: [] });
  });

  it("a missing / not-owned key lands in failed while the others still delete", async () => {
    mockGetSql.mockReturnValue(fakeSql({ owned: ["x", "z"] }));

    const result = await bulkDelete(["x", "ghost", "z"]);

    expect(result.changed).toEqual(["x", "z"]);
    expect(result.failed).toEqual([{ key: "ghost", error: 'No experiment with key "ghost".' }]);
  });

  it("a thrown DB fault on one key is captured in failed, not propagated", async () => {
    mockGetSql.mockReturnValue(
      fakeSql({ owned: ["x"], errors: new Map([["y", new Error("deadlock detected")]]) }),
    );

    const result = await bulkDelete(["x", "y"]);

    expect(result.changed).toEqual(["x"]);
    expect(result.failed).toEqual([{ key: "y", error: "deadlock detected" }]);
  });

  it("an empty keys array is a no-op — {changed:[], failed:[]}, no DB touched", async () => {
    const result = await bulkDelete([]);

    expect(result).toEqual({ changed: [], failed: [] });
    expect(mockGetSql).not.toHaveBeenCalled();
    expect(mockGetCurrentProjectId).not.toHaveBeenCalled();
  });
});
