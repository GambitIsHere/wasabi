// ============================================================================
// users.ts — behavioural tests for the pure helpers (email normalisation,
// unique-violation detection).
// ----------------------------------------------------------------------------
// The DB-backed CRUD functions (findUserByEmail, createUser, setUserStatus)
// are exercised via browser verification against the real local Postgres —
// see lib/membership.test.ts's header for why that split matches this
// codebase's existing testing convention.
// ============================================================================
import { describe, expect, it } from "vitest";
import { isUniqueViolation, normalizeEmail } from "@/lib/users";

describe("normalizeEmail", () => {
  it("lowercases", () => {
    expect(normalizeEmail("Alice@Sanjow.COM")).toBe("alice@sanjow.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeEmail("  alice@sanjow.com  ")).toBe("alice@sanjow.com");
  });

  it("is idempotent — normalising twice is the same as once", () => {
    const once = normalizeEmail("  Alice@Sanjow.COM  ");
    expect(normalizeEmail(once)).toBe(once);
  });
});

describe("isUniqueViolation", () => {
  it("recognises a Postgres unique-violation error (SQLSTATE 23505)", () => {
    expect(isUniqueViolation({ code: "23505", message: "duplicate key" })).toBe(true);
  });

  it("rejects a different Postgres error code", () => {
    expect(isUniqueViolation({ code: "23503", message: "foreign key violation" })).toBe(false);
  });

  it("rejects a plain Error with no code", () => {
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
  });

  it("rejects non-object values without throwing", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation(23505)).toBe(false);
  });

  it("falls back to matching the message when .code is absent (M2: app/actions.ts / lib/archive.ts)", () => {
    expect(
      isUniqueViolation({
        message: 'duplicate key value violates unique constraint "experiment_pkey"',
      }),
    ).toBe(true);
  });

  it("the message fallback rejects unrelated wording", () => {
    expect(isUniqueViolation({ message: "connection timed out" })).toBe(false);
  });

  it("trusts a PRESENT .code over the message — a non-23505 code is never overridden by wording", () => {
    expect(
      isUniqueViolation({
        code: "23503", // foreign_key_violation
        message: "duplicate key value violates unique constraint (unrelated wording, wrong code)",
      }),
    ).toBe(false);
  });
});
