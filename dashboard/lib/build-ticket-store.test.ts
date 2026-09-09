// ============================================================================
// build-ticket-store.ts — the ledger's claim-first idempotency, DB-mocked.
// ----------------------------------------------------------------------------
// @/lib/db + @/lib/tenant are mocked (the codebase's DB-free unit convention —
// same vi.mock pattern as lib/archive.test.ts). The fake `sql` client returns a
// queued result per invocation, so the REAL claim/lookup logic runs end to end
// and we assert what it does when the INSERT wins vs conflicts.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ createSchema: vi.fn(), getSql: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getCurrentOrgId: vi.fn() }));

import { createSchema, getSql } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/tenant";
import {
  claimBuildTicket,
  getBuildTicket,
  type ClaimInput,
} from "@/lib/build-ticket-store";

const mockCreateSchema = vi.mocked(createSchema);
const mockGetSql = vi.mocked(getSql);
const mockGetCurrentOrgId = vi.mocked(getCurrentOrgId);

/** A fake tagged-template `sql` that returns queued results, one per call, and
 *  records how many times it was invoked. */
function queuedSql(results: unknown[]): { sql: ReturnType<typeof getSql>; calls: () => number } {
  let i = 0;
  let count = 0;
  const fn = ((_s: TemplateStringsArray, ..._v: unknown[]) => {
    count += 1;
    return Promise.resolve(results[i++] ?? []);
  }) as unknown as ReturnType<typeof getSql>;
  return { sql: fn, calls: () => count };
}

const CLAIM: ClaimInput = {
  sourceTicket: "GP-573",
  themeSlug: "tu_promo_marquee",
  business: "Top Up",
  project: "GP",
  summary: "TU | Build variant tu_promo_marquee",
  createdBy: "user-1",
};

const RAW_EXISTING = {
  id: "row-existing",
  source_ticket: "GP-573",
  theme_slug: "tu_promo_marquee",
  business: "Top Up",
  project: "GP",
  summary: "TU | Build variant tu_promo_marquee",
  created_ticket: "GP-742",
  status: "created",
  created_by: "user-1",
  created_at: new Date("2026-09-08T00:00:00Z").toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateSchema.mockResolvedValue(undefined);
  mockGetCurrentOrgId.mockResolvedValue("sanjow");
});

describe("claimBuildTicket — the INSERT wins", () => {
  it("returns { claimed: true, id } with a generated id", async () => {
    const { sql } = queuedSql([[{ id: "ignored-db-id" }]]); // RETURNING id → one row
    mockGetSql.mockReturnValue(sql);

    const res = await claimBuildTicket(CLAIM);
    expect(res.claimed).toBe(true);
    if (res.claimed) expect(res.id.length).toBeGreaterThan(0);
  });
});

describe("claimBuildTicket — the INSERT conflicts (already promoted)", () => {
  it("returns { claimed: false, existing } from the follow-up lookup — no duplicate", async () => {
    // 1st call (INSERT … ON CONFLICT DO NOTHING RETURNING) → [] (nothing inserted)
    // 2nd call (SELECT existing)                            → [RAW_EXISTING]
    const { sql, calls } = queuedSql([[], [RAW_EXISTING]]);
    mockGetSql.mockReturnValue(sql);

    const res = await claimBuildTicket(CLAIM);
    expect(res.claimed).toBe(false);
    if (!res.claimed) {
      expect(res.existing.createdTicket).toBe("GP-742");
      expect(res.existing.status).toBe("created");
      expect(res.existing.sourceTicket).toBe("GP-573");
    }
    expect(calls()).toBe(2); // claimed the slot, then read the winner
  });

  it("still reports claimed:false when the conflict row vanished between INSERT and SELECT", async () => {
    const { sql } = queuedSql([[], []]); // conflict, then no row found
    mockGetSql.mockReturnValue(sql);

    const res = await claimBuildTicket(CLAIM);
    expect(res.claimed).toBe(false);
    if (!res.claimed) expect(res.existing.status).toBe("creating");
  });
});

describe("getBuildTicket", () => {
  it("maps a row when present", async () => {
    const { sql } = queuedSql([[RAW_EXISTING]]);
    mockGetSql.mockReturnValue(sql);
    const row = await getBuildTicket("GP-573", "tu_promo_marquee");
    expect(row?.createdTicket).toBe("GP-742");
  });

  it("returns null when absent", async () => {
    const { sql } = queuedSql([[]]);
    mockGetSql.mockReturnValue(sql);
    const row = await getBuildTicket("GP-999", "tu_none");
    expect(row).toBeNull();
  });
});
