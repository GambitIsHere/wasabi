// ============================================================================
// archive.ts — M2: upsertManyArchived must not leak cross-tenant key
// existence through a raw Postgres error message in failed[].error.
// ----------------------------------------------------------------------------
// archived_experiment.key is a GLOBAL primary key across tenants (see
// lib/tenant.ts's KNOWN LIMITATION note). upsertArchived's own DELETE is
// project-scoped (a same-tenant re-import deletes its own row first, so it
// never conflicts — see that function's header comment), so a unique-
// violation reaching upsertManyArchived's catch can ONLY mean the key
// belongs to a DIFFERENT tenant. The raw Postgres message names that key,
// which would confirm to the caller that another tenant already owns it —
// this must come back genericised instead.
//
// DB-touching deps (@/lib/db, @/lib/tenant) are mocked with a minimal fake
// `sql` client (this codebase's DB-free unit-test convention — same vi.mock
// pattern as lib/experiments.test.ts / lib/authz.test.ts), so the REAL
// upsertArchived/upsertManyArchived logic runs end to end down to the actual
// `sql.transaction([...])` call, which is where the synthetic Postgres error
// is injected. @/lib/users's isUniqueViolation is left REAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  createSchema: vi.fn(),
  getSql: vi.fn(),
}));
vi.mock("@/lib/tenant", () => ({ getCurrentProjectId: vi.fn() }));

import { createSchema, getSql } from "@/lib/db";
import { getCurrentProjectId } from "@/lib/tenant";
import { upsertManyArchived, type ArchivedInput } from "@/lib/archive";

const mockCreateSchema = vi.mocked(createSchema);
const mockGetSql = vi.mocked(getSql);
const mockGetCurrentProjectId = vi.mocked(getCurrentProjectId);

/** The minimal shape upsertArchived actually uses: a callable tagged-template
 *  function plus a `.transaction()` method. Cast to the driver's real return
 *  type at the injection point below — the rest of NeonQueryFunction's
 *  surface (query/unsafe/…) is never touched by the code under test. */
type FakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => unknown) & {
  transaction: (queries: unknown[]) => Promise<unknown>;
};

function fakeSql(transactionImpl: () => Promise<unknown>): ReturnType<typeof getSql> {
  const fn = ((_strings: TemplateStringsArray, ..._values: unknown[]) => undefined) as FakeSql;
  fn.transaction = transactionImpl;
  return fn as unknown as ReturnType<typeof getSql>;
}

function input(key: string, name: string): ArchivedInput {
  return {
    key,
    name,
    business: "Top Up",
    variants: [{ key: "control", isControl: true, visitors: 100, conversions: 10 }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateSchema.mockResolvedValue(undefined);
  mockGetCurrentProjectId.mockResolvedValue("proj-1");
});

describe("upsertManyArchived — cross-tenant key collision (M2)", () => {
  it("genericises a unique-violation for the colliding item, while a clean item in the same batch still imports", async () => {
    mockGetSql
      .mockReturnValueOnce(
        fakeSql(() =>
          Promise.reject({
            code: "23505",
            message:
              'duplicate key value violates unique constraint "archived_experiment_pkey" (key)=(shared-key)',
          }),
        ),
      )
      .mockReturnValueOnce(fakeSql(() => Promise.resolve([])));

    const result = await upsertManyArchived([
      input("shared-key", "Owned By Another Tenant"),
      input("my-own-key", "A Clean Import"),
    ]);

    expect(result.imported).toEqual(["my-own-key"]);
    expect(result.failed).toEqual([
      { name: "Owned By Another Tenant", error: "That experiment key is already in use — pick another." },
    ]);
  });

  it("does NOT genericise an unrelated failure — the real message still surfaces", async () => {
    mockGetSql.mockReturnValueOnce(fakeSql(() => Promise.reject(new Error("Neon connection timed out"))));

    const result = await upsertManyArchived([input("some-key", "Flaky Import")]);

    expect(result.imported).toEqual([]);
    expect(result.failed).toEqual([{ name: "Flaky Import", error: "Neon connection timed out" }]);
  });
});
