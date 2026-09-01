// ============================================================================
// password.ts — hash/verify round-trip + strength-policy tests.
// ----------------------------------------------------------------------------
// hashPassword/verifyPassword hit the real @node-rs/argon2 native binding
// (no mocking — a mock would prove nothing about whether the actual
// dependency is wired correctly), so this file keeps the number of real
// hashes small; validatePasswordStrength is pure/instant and gets the bulk
// of the case coverage.
// ============================================================================
import { describe, expect, it } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
} from "@/lib/password";

describe("hashPassword / verifyPassword", () => {
  it("round-trips: the exact password used to hash verifies true", async () => {
    const hash = await hashPassword("correct horse battery staple 9!");
    await expect(verifyPassword(hash, "correct horse battery staple 9!")).resolves.toBe(true);
  });

  it("a wrong password verifies false", async () => {
    const hash = await hashPassword("correct horse battery staple 9!");
    await expect(verifyPassword(hash, "wrong horse battery staple 9!")).resolves.toBe(false);
  });

  it("never stores the plaintext — the hash string doesn't contain the password", async () => {
    const password = "correct horse battery staple 9!";
    const hash = await hashPassword(password);
    expect(hash).not.toContain(password);
  });

  it("produces a self-describing argon2id PHC string with the stated parameters", async () => {
    const hash = await hashPassword("correct horse battery staple 9!");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it("two hashes of the same password differ (random salt per hash) but both verify", async () => {
    const password = "correct horse battery staple 9!";
    const [a, b] = await Promise.all([hashPassword(password), hashPassword(password)]);
    expect(a).not.toBe(b);
    await expect(verifyPassword(a, password)).resolves.toBe(true);
    await expect(verifyPassword(b, password)).resolves.toBe(true);
  });

  it("a malformed stored hash fails closed (false), not a thrown error", async () => {
    await expect(verifyPassword("not-a-real-hash", "anything")).resolves.toBe(false);
  });
});

describe("validatePasswordStrength — length floor", () => {
  it("rejects anything shorter than the minimum", () => {
    expect(validatePasswordStrength("short1234")).toMatch(new RegExp(String(MIN_PASSWORD_LENGTH)));
  });

  it(`accepts exactly ${MIN_PASSWORD_LENGTH} characters when otherwise strong`, () => {
    // 12 chars, not sequential, not repeated, not in the blocklist.
    expect(validatePasswordStrength("xK9!mQ2#vL7$")).toBeNull();
  });
});

describe("validatePasswordStrength — trivially guessable patterns", () => {
  it("rejects a single repeated character", () => {
    expect(validatePasswordStrength("aaaaaaaaaaaa")).toMatch(/repeated/);
  });

  it("rejects an ascending sequence", () => {
    expect(validatePasswordStrength("abcdefghijkl")).toMatch(/sequence/);
  });

  it("rejects a numeric sequence (whether caught as a sequence or a common blocklisted password)", () => {
    // "123456789012" isn't purely ascending BY CHARACTER CODE for its full
    // length (digits wrap 9→0, which isSequential's strict charCode check
    // correctly does NOT treat as sequential) — it's caught by the common-
    // password blocklist instead. Either mechanism rejecting it is correct;
    // this test pins the outcome (rejected), not which internal check fired.
    expect(validatePasswordStrength("123456789012")).not.toBeNull();
  });

  it("rejects a descending sequence", () => {
    expect(validatePasswordStrength("lkjihgfedcba")).toMatch(/sequence/);
  });

  it("rejects a known common weak password", () => {
    expect(validatePasswordStrength("password1234")).toMatch(/common/);
  });

  it("is case-insensitive against the blocklist", () => {
    expect(validatePasswordStrength("PASSWORD1234")).toMatch(/common/);
  });
});

describe("validatePasswordStrength — email-derived password", () => {
  it("rejects a password equal to the account's own email", () => {
    expect(validatePasswordStrength("alice@sanjow.com!!", "alice@sanjow.com!!")).toMatch(/email/);
  });

  it("rejects a password equal to the email's local-part alone", () => {
    expect(validatePasswordStrength("alicealicealice", "alicealicealice@sanjow.com")).toMatch(
      /email/,
    );
  });

  it("does not flag an unrelated strong password against a given email", () => {
    expect(validatePasswordStrength("xK9!mQ2#vL7$", "alice@sanjow.com")).toBeNull();
  });

  it("skips the email check entirely when no email is given", () => {
    expect(validatePasswordStrength("xK9!mQ2#vL7$")).toBeNull();
  });
});

describe("validatePasswordStrength — accepts genuinely strong passwords", () => {
  it.each([
    "correct horse battery staple 9!",
    "Tr0ub4dor&3-extended",
    "purple-Elephant-42-jumps",
  ])("accepts %s", (password) => {
    expect(validatePasswordStrength(password)).toBeNull();
  });
});
