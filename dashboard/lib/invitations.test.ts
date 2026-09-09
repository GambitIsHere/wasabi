// ============================================================================
// invitations.ts — behavioural tests.
// ----------------------------------------------------------------------------
// Split in two, matching lib/invitations.ts's own "TESTABILITY SPLIT" (see
// that file's header):
//
//   1. PURE decision logic — invitationStatus, emailMatchesInvitation,
//      isInvitationRole, hashInvitationToken — tested directly, zero
//      mocking. Every security property the batch spec calls out (expiry,
//      single-use, the email-match gate, the domain bypass, role
//      validation, revoke-then-accept) reduces to one of these functions,
//      so this is where most of the real coverage lives.
//
//   2. The DB-backed CRUD (createInvitation, getInvitationByToken,
//      acceptInvitation, revokeInvitation, list*). Unlike
//      authorizeCredentials/requireRole (lib/credentials-auth.test.ts /
//      lib/authz.test.ts), which only ever call OTHER already-tested
//      modules and so are mockable by mocking those siblings, these
//      functions issue their own raw SQL — closer in shape to
//      lib/membership.ts's/lib/users.ts's CRUD, which this codebase's
//      convention leaves to browser verification instead of vitest (see
//      those files' test headers). The spec explicitly asks for coverage of
//      multi-step, DB-shaped behaviour here too (single-use across two
//      calls, tenant-scoped revoke) that the pure split alone can't reach,
//      so this file additionally mocks @/lib/db directly (one level deeper
//      than the existing vi.mock-a-dependency convention, justified because
//      these functions own their SQL) — a small vi.fn() standing in for
//      Neon's sql`…` tagged template, configured per test via
//      mockResolvedValueOnce in the exact order lib/invitations.ts issues
//      its statements. This keeps `npm test` fully offline (no
//      docker-compose local Postgres needed).
//
// Tenant scoping of every OTHER invitation statement (create/list/revoke all
// carry org_id) is additionally guarded automatically by
// lib/tenant-scoping.test.ts's static scan, which now registers
// "invitation" — see that file.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  createSchema: vi.fn(),
  getSql: vi.fn(),
}));
vi.mock("@/lib/membership", () => ({
  findOrCreateMembership: vi.fn(),
}));

import { createSchema, getSql } from "@/lib/db";
import { findOrCreateMembership } from "@/lib/membership";
import {
  acceptInvitation,
  createInvitation,
  emailMatchesInvitation,
  getInvitationByToken,
  hashInvitationToken,
  invitationStatus,
  isInvitationRole,
  listInvitations,
  listPendingInvitations,
  revokeInvitation,
} from "@/lib/invitations";

const mockCreateSchema = vi.mocked(createSchema);
const mockGetSql = vi.mocked(getSql);
const mockFindOrCreateMembership = vi.mocked(findOrCreateMembership);

/** Stands in for Neon's `sql` tagged-template client — see this file's
 *  header. Re-created fresh in beforeEach so no test's queued
 *  mockResolvedValueOnce responses can leak into the next. */
let mockSql = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockSql = vi.fn();
  mockCreateSchema.mockResolvedValue(undefined);
  mockGetSql.mockReturnValue(mockSql as unknown as ReturnType<typeof getSql>);
});

/** A tagged-template call is `fn(stringsArray, ...values)` — this strips the
 *  leading strings array, leaving just the interpolated values in order. */
function callValues(callIndex: number): unknown[] {
  const call = mockSql.mock.calls[callIndex];
  if (!call) throw new Error(`callValues: mockSql was not called a ${callIndex + 1}th time`);
  return (call as unknown[]).slice(1);
}

/** The literal SQL text of one call (strings array joined), for a light
 *  "is this the statement I think it is" sanity check. */
function callText(callIndex: number): string {
  const call = mockSql.mock.calls[callIndex];
  if (!call) throw new Error(`callText: mockSql was not called a ${callIndex + 1}th time`);
  return ((call as unknown[])[0] as readonly string[]).join(" ");
}

interface Row {
  id: string;
  org_id: string;
  email: string;
  role: string;
  token_hash: string;
  token_prefix: string;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function row(overrides: Partial<Row> = {}): Row {
  const now = Date.now();
  return {
    id: "inv-1",
    org_id: "acme",
    email: "consultant@other.io",
    role: "editor",
    token_hash: "placeholder-hash",
    token_prefix: "abcd1234",
    invited_by: "admin-1",
    created_at: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + SEVEN_DAYS_MS).toISOString(),
    accepted_at: null,
    revoked_at: null,
    ...overrides,
  };
}

// ============================================================================
// 1. Pure decision logic — no mocking, no I/O.
// ============================================================================

describe("invitationStatus — pure, no I/O", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();

  it("a fresh invite (nothing accepted/revoked, not yet expired) is pending", () => {
    expect(invitationStatus({ acceptedAt: null, revokedAt: null, expiresAt: future })).toBe("pending");
  });

  it("expiry rejection: past expires_at with nothing else set is expired", () => {
    expect(invitationStatus({ acceptedAt: null, revokedAt: null, expiresAt: past })).toBe("expired");
  });

  it("exactly AT expires_at counts as expired (inclusive boundary)", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(invitationStatus({ acceptedAt: null, revokedAt: null, expiresAt: now.toISOString() }, now)).toBe(
      "expired",
    );
  });

  it("🔴 single-use: an accepted_at timestamp makes it accepted, even if not yet expired", () => {
    expect(
      invitationStatus({ acceptedAt: new Date().toISOString(), revokedAt: null, expiresAt: future }),
    ).toBe("accepted");
  });

  it("revoke then accept: a revoked_at timestamp makes it revoked, even if not yet expired", () => {
    expect(
      invitationStatus({ acceptedAt: null, revokedAt: new Date().toISOString(), expiresAt: future }),
    ).toBe("revoked");
  });

  it("revoked wins over accepted when both are set", () => {
    const ts = new Date().toISOString();
    expect(invitationStatus({ acceptedAt: ts, revokedAt: ts, expiresAt: future })).toBe("revoked");
  });

  it("revoked wins over expired", () => {
    expect(
      invitationStatus({ acceptedAt: null, revokedAt: new Date().toISOString(), expiresAt: past }),
    ).toBe("revoked");
  });

  it("accepted wins over expired", () => {
    expect(
      invitationStatus({ acceptedAt: new Date().toISOString(), revokedAt: null, expiresAt: past }),
    ).toBe("accepted");
  });
});

describe("emailMatchesInvitation — the entire anti-leaked-link gate", () => {
  it("matches an identical email", () => {
    expect(emailMatchesInvitation({ email: "consultant@other.io" }, "consultant@other.io")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(emailMatchesInvitation({ email: "consultant@other.io" }, "Consultant@Other.IO")).toBe(true);
  });

  it("matches through surrounding whitespace on the candidate side", () => {
    expect(emailMatchesInvitation({ email: "consultant@other.io" }, "  consultant@other.io  ")).toBe(true);
  });

  it("🔴 the email-match enforcement: rejects a completely different email", () => {
    expect(emailMatchesInvitation({ email: "consultant@other.io" }, "attacker@evil.com")).toBe(false);
  });

  it("rejects a different local part on the SAME domain", () => {
    expect(emailMatchesInvitation({ email: "consultant@other.io" }, "someone-else@other.io")).toBe(false);
  });

  it("🔴 the domain bypass: an email off any org's domain still matches ITS OWN invitation", () => {
    // The whole point (see lib/invitations.ts's header) — this function
    // takes no domain/org parameter at all, so a match can only ever depend
    // on (this invite's stored email == the candidate), never on which
    // domain either one is on.
    const email = "freelancer@totally-unrelated-domain.io";
    expect(emailMatchesInvitation({ email }, email)).toBe(true);
  });
});

describe("isInvitationRole — role validation", () => {
  it("accepts admin, editor, viewer", () => {
    expect(isInvitationRole("admin")).toBe(true);
    expect(isInvitationRole("editor")).toBe(true);
    expect(isInvitationRole("viewer")).toBe(true);
  });

  it("🔴 role validation: rejects owner — an invite can never grant ownership", () => {
    expect(isInvitationRole("owner")).toBe(false);
  });

  it("rejects an unrecognised string", () => {
    expect(isInvitationRole("superadmin")).toBe(false);
    expect(isInvitationRole("")).toBe(false);
  });
});

describe("hashInvitationToken — token hash/verify round trip", () => {
  it("is deterministic — the same raw token always hashes the same way", () => {
    const token = "example-raw-token-value";
    expect(hashInvitationToken(token)).toBe(hashInvitationToken(token));
  });

  it("different tokens hash to different values", () => {
    expect(hashInvitationToken("token-a")).not.toBe(hashInvitationToken("token-b"));
  });

  it("produces a 64-character lowercase hex SHA-256 digest", () => {
    expect(hashInvitationToken("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the hash is never the raw token itself", () => {
    const token = "example-raw-token-value";
    expect(hashInvitationToken(token)).not.toBe(token);
  });
});

// ============================================================================
// 2. DB-backed CRUD, against the mocked @/lib/db boundary.
// ============================================================================

describe("getInvitationByToken", () => {
  it("hashes the raw token and looks it up by that hash (the round trip)", async () => {
    mockSql.mockResolvedValueOnce([row({ id: "inv-1" })]);

    const inv = await getInvitationByToken("raw-token-123");

    expect(inv?.id).toBe("inv-1");
    expect(callValues(0)).toEqual([hashInvitationToken("raw-token-123")]);
  });

  it("returns null when no row matches", async () => {
    mockSql.mockResolvedValueOnce([]);
    await expect(getInvitationByToken("nonexistent")).resolves.toBeNull();
  });

  it("an unrecognised role value in the row fails closed to 'viewer'", async () => {
    mockSql.mockResolvedValueOnce([row({ role: "some-future-role" })]);
    const inv = await getInvitationByToken("token");
    expect(inv?.role).toBe("viewer");
  });
});

describe("acceptInvitation — security properties", () => {
  const acceptingUser = { id: "user-1", email: "consultant@other.io" };

  it("an unknown token is rejected without touching membership", async () => {
    mockSql.mockResolvedValueOnce([]); // getInvitationByToken finds nothing

    const result = await acceptInvitation("bad-token", acceptingUser);

    expect(result).toEqual({ ok: false, reason: "This invitation link is invalid." });
    expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
  });

  it("🔴 single-use: an already-accepted invitation is rejected (second accept fails)", async () => {
    mockSql.mockResolvedValueOnce([row({ accepted_at: new Date().toISOString() })]);

    const result = await acceptInvitation("used-token", acceptingUser);

    expect(result).toEqual({ ok: false, reason: "This invitation has already been used." });
    expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
  });

  it("expiry rejection: an expired invitation is rejected", async () => {
    mockSql.mockResolvedValueOnce([row({ expires_at: new Date(Date.now() - 1_000).toISOString() })]);

    const result = await acceptInvitation("expired-token", acceptingUser);

    expect(result).toEqual({ ok: false, reason: "This invitation has expired." });
    expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
  });

  it("revoke then accept fails", async () => {
    mockSql.mockResolvedValueOnce([row({ revoked_at: new Date().toISOString() })]);

    const result = await acceptInvitation("revoked-token", acceptingUser);

    expect(result).toEqual({ ok: false, reason: "This invitation has been revoked." });
    expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
  });

  it("🔴 the email-match enforcement: a different signed-in email is rejected", async () => {
    mockSql.mockResolvedValueOnce([row({ email: "consultant@other.io" })]);

    const result = await acceptInvitation("token", { id: "attacker-id", email: "attacker@evil.com" });

    expect(result).toEqual({
      ok: false,
      reason: "This invitation was issued to a different email address.",
    });
    expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
  });

  it("🔴 the domain bypass: a pending invite for an off-domain email accepts successfully", async () => {
    const email = "freelancer@totally-unrelated-domain.io";
    mockSql
      .mockResolvedValueOnce([row({ id: "inv-1", email, org_id: "acme", role: "editor" })]) // lookup
      .mockResolvedValueOnce([{ id: "inv-1" }]); // the claim UPDATE … RETURNING id

    const result = await acceptInvitation("good-token", { id: "user-1", email });

    expect(result).toEqual({ ok: true, orgId: "acme", role: "editor" });
    expect(mockFindOrCreateMembership).toHaveBeenCalledWith("user-1", "acme", "editor");
  });

  it("grants the role recorded on the invitation, not any default", async () => {
    mockSql.mockResolvedValueOnce([row({ id: "inv-1", role: "admin" })]).mockResolvedValueOnce([{ id: "inv-1" }]);

    const result = await acceptInvitation("token", acceptingUser);

    expect(result).toMatchObject({ ok: true, role: "admin" });
    expect(mockFindOrCreateMembership).toHaveBeenCalledWith("user-1", "acme", "admin");
  });

  it("the claim UPDATE is scoped to both the invitation's id and its org_id, and claims via RETURNING id", async () => {
    mockSql.mockResolvedValueOnce([row({ id: "inv-42", org_id: "acme" })]).mockResolvedValueOnce([{ id: "inv-42" }]);

    await acceptInvitation("token", acceptingUser);

    expect(callValues(1)).toEqual(["inv-42", "acme"]);
    const claimText = callText(1).toUpperCase();
    expect(claimText).toContain("ACCEPTED_AT");
    expect(claimText).toContain("RETURNING ID");
  });

  it("🔴 the invite is claimed (the guarded UPDATE) BEFORE membership is granted — never grants membership for a call that didn't win the claim", async () => {
    const order: string[] = [];
    mockFindOrCreateMembership.mockImplementation(async () => {
      order.push("membership");
      return { userId: "u", orgId: "acme", role: "editor", createdAt: new Date().toISOString() };
    });
    mockSql
      .mockImplementationOnce(async () => {
        order.push("sql:lookup");
        return [row({ id: "inv-1" })]; // getInvitationByToken needs a full row shape
      })
      .mockImplementationOnce(async () => {
        order.push("sql:claim");
        return [{ id: "inv-1" }]; // the claim UPDATE … RETURNING id
      });

    await acceptInvitation("token", acceptingUser);

    // The lookup, then THE CLAIM — both happen before membership is
    // granted, never after. (Previously findOrCreateMembership ran BEFORE
    // the accept UPDATE, which is exactly the bug this ordering fixes — see
    // acceptInvitation's "Race note".)
    expect(order).toEqual(["sql:lookup", "sql:claim", "membership"]);
  });

  it("🔴 a zero-row claim (raced revoke/accept) does NOT grant membership and returns ok:false", async () => {
    mockSql
      .mockResolvedValueOnce([row({ id: "inv-1", org_id: "acme" })]) // lookup: still looked pending
      .mockResolvedValueOnce([]); // the claim UPDATE: someone else won the race — zero rows

    const result = await acceptInvitation("token", acceptingUser);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no longer available/i);
    }
    expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
  });
});

describe("createInvitation", () => {
  it("🔴 role validation: rejects 'owner' before touching the database", async () => {
    await expect(createInvitation("acme", "person@other.io", "owner", "admin-1")).rejects.toThrow(
      /not an invitable role/,
    );
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects an unrecognised role string", async () => {
    await expect(createInvitation("acme", "person@other.io", "superadmin", "admin-1")).rejects.toThrow();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("validates email shape before touching the database", async () => {
    await expect(createInvitation("acme", "not-an-email", "editor", "admin-1")).rejects.toThrow(
      /not a valid email/,
    );
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("lowercases the stored email", async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([row({ email: "person@other.io" })]);

    await createInvitation("acme", "Person@Other.IO", "editor", "admin-1");

    // INSERT column order: id, org_id, email, role, token_hash, …
    expect(callValues(1)[2]).toBe("person@other.io");
  });

  it("stores the hash of the returned raw token, never the raw token itself", async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([row()]);

    const { rawToken } = await createInvitation("acme", "person@other.io", "editor", "admin-1");

    const insertValues = callValues(1);
    expect(insertValues[4]).toBe(hashInvitationToken(rawToken)); // token_hash column
    expect(insertValues).not.toContain(rawToken);
  });

  it("when a still-usable invite already exists for (org, email), refreshes it instead of inserting a new one", async () => {
    mockSql
      .mockResolvedValueOnce([row({ id: "inv-existing" })]) // existing-check finds one
      .mockResolvedValueOnce([row({ id: "inv-existing", role: "admin" })]); // UPDATE … RETURNING

    const { invitation } = await createInvitation("acme", "person@other.io", "admin", "admin-1");

    expect(invitation.id).toBe("inv-existing");
    expect(mockSql).toHaveBeenCalledTimes(2); // existing-check + UPDATE, no separate INSERT
    expect(callText(1).toUpperCase()).toContain("UPDATE");
  });

  it("the refresh UPDATE is guarded against a row that got accepted/revoked in the meantime", async () => {
    mockSql.mockResolvedValueOnce([row({ id: "inv-existing" })]).mockResolvedValueOnce([row({ id: "inv-existing" })]);

    await createInvitation("acme", "person@other.io", "editor", "admin-1");

    const refreshText = callText(1).toUpperCase();
    expect(refreshText).toContain("ACCEPTED_AT IS NULL");
    expect(refreshText).toContain("REVOKED_AT IS NULL");
  });

  it("🔴 when a refresh races a concurrent accept, falls through to inserting a new row instead of throwing", async () => {
    mockSql
      .mockResolvedValueOnce([row({ id: "inv-existing" })]) // existing-check finds one (was pending at read time)
      .mockResolvedValueOnce([]) // guarded refresh UPDATE: zero rows — it got accepted in the meantime
      .mockResolvedValueOnce([row({ id: "inv-brand-new" })]); // falls through to INSERT … RETURNING

    const { invitation } = await createInvitation("acme", "person@other.io", "editor", "admin-1");

    expect(invitation.id).toBe("inv-brand-new");
    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(callText(1).toUpperCase()).toContain("UPDATE"); // the raced refresh attempt
    expect(callText(2).toUpperCase()).toContain("INSERT"); // the fallthrough insert
  });

  it("issues a fresh, different token on refresh — the old link stops working", async () => {
    mockSql
      .mockResolvedValueOnce([row({ id: "inv-existing", token_hash: "old-hash-value" })])
      .mockResolvedValueOnce([row({ id: "inv-existing" })]);

    const { rawToken } = await createInvitation("acme", "person@other.io", "editor", "admin-1");

    expect(hashInvitationToken(rawToken)).not.toBe("old-hash-value");
  });

  it("the existing-invite lookup is scoped to the given org and email", async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([row()]);

    await createInvitation("acme", "person@other.io", "editor", "admin-1");

    expect(callValues(0)).toEqual(["acme", "person@other.io"]);
  });

  it("inserts with no existing invite found", async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([row()]);

    await createInvitation("acme", "person@other.io", "editor", "admin-1");

    expect(callText(1).toUpperCase()).toContain("INSERT");
  });
});

describe("revokeInvitation — tenant scoping", () => {
  it("revokes an invitation that belongs to the given org", async () => {
    mockSql.mockResolvedValueOnce([row({ id: "inv-1", org_id: "acme", revoked_at: new Date().toISOString() })]);

    const result = await revokeInvitation("inv-1", "acme");

    expect(result?.id).toBe("inv-1");
    expect(callValues(0)).toEqual(["inv-1", "acme"]);
  });

  it("🔴 tenant scoping: cannot revoke another org's invitation", async () => {
    // The real WHERE id = … AND org_id = … matches zero rows when the id
    // belongs to a DIFFERENT org than the one calling — simulated here by
    // the mocked response coming back empty.
    mockSql.mockResolvedValueOnce([]);

    const result = await revokeInvitation("inv-belongs-to-other-org", "acme");

    expect(result).toBeNull();
    // The call was still scoped by the CALLER's own org — proving isolation
    // is enforced by the query's WHERE, not by coincidence of the fixture.
    expect(callValues(0)).toEqual(["inv-belongs-to-other-org", "acme"]);
  });

  it("a second revoke of an already-revoked invitation is a no-op (returns null, doesn't stomp the timestamp)", async () => {
    mockSql.mockResolvedValueOnce([]); // WHERE …AND revoked_at IS NULL now matches nothing
    await expect(revokeInvitation("inv-1", "acme")).resolves.toBeNull();
  });
});

describe("listInvitations / listPendingInvitations", () => {
  it("listInvitations scopes by org_id and returns every invitation regardless of status", async () => {
    mockSql.mockResolvedValueOnce([
      row({ id: "inv-1" }),
      row({ id: "inv-2", accepted_at: new Date().toISOString() }),
      row({ id: "inv-3", revoked_at: new Date().toISOString() }),
    ]);

    const list = await listInvitations("acme");

    expect(list.map((i) => i.id)).toEqual(["inv-1", "inv-2", "inv-3"]);
    expect(callValues(0)).toEqual(["acme"]);
  });

  it("listPendingInvitations keeps only invitations invitationStatus() calls pending", async () => {
    mockSql.mockResolvedValueOnce([
      row({ id: "inv-pending" }),
      row({ id: "inv-accepted", accepted_at: new Date().toISOString() }),
      row({ id: "inv-revoked", revoked_at: new Date().toISOString() }),
      row({ id: "inv-expired", expires_at: new Date(Date.now() - 1_000).toISOString() }),
    ]);

    const list = await listPendingInvitations("acme");

    expect(list.map((i) => i.id)).toEqual(["inv-pending"]);
  });
});
