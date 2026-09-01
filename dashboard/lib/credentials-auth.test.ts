// ============================================================================
// credentials-auth.ts — behavioural tests for the core Credentials-login gate.
// ----------------------------------------------------------------------------
// The batch's explicit "a pending user cannot get an authorized session"
// requirement, plus every other way authorize() must fail closed. lib/users,
// lib/password, lib/membership are mocked (same vi.mock pattern proven
// against dynamic imports in lib/tenant.test.ts) so this tests the GATE
// LOGIC itself, not the database or the real argon2 binding (lib/password.ts
// already has its own hash/verify round-trip coverage).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/users", () => ({ findUserByEmail: vi.fn() }));
vi.mock("@/lib/password", () => ({ verifyPassword: vi.fn() }));
vi.mock("@/lib/membership", () => ({ getMembership: vi.fn() }));

import { findUserByEmail } from "@/lib/users";
import { verifyPassword } from "@/lib/password";
import { getMembership } from "@/lib/membership";
import { authorizeCredentials } from "@/lib/credentials-auth";
import type { User } from "@/lib/users";
import type { Membership } from "@/lib/membership";

const mockFindUserByEmail = vi.mocked(findUserByEmail);
const mockVerifyPassword = vi.mocked(verifyPassword);
const mockGetMembership = vi.mocked(getMembership);

const ORG_ID = "sanjow";

function activeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "alice@sanjow.com",
    name: "Alice",
    image: null,
    passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$salt$hash",
    emailVerifiedAt: null,
    status: "active",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function membershipRow(overrides: Partial<Membership> = {}): Membership {
  return { userId: "user-1", orgId: ORG_ID, role: "viewer", createdAt: new Date().toISOString(), ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authorizeCredentials — the happy path", () => {
  it("returns the authorized user for a correct password, active account, and matching membership", async () => {
    mockFindUserByEmail.mockResolvedValue(activeUser());
    mockVerifyPassword.mockResolvedValue(true);
    mockGetMembership.mockResolvedValue(membershipRow({ role: "editor" }));

    const result = await authorizeCredentials("alice@sanjow.com", "correct-password", ORG_ID);

    expect(result).toEqual({
      id: "user-1",
      email: "alice@sanjow.com",
      name: "Alice",
      image: null,
      orgId: ORG_ID,
      role: "editor",
    });
  });
});

describe("authorizeCredentials — 🔴 a pending user cannot get an authorized session", () => {
  it("rejects a 'pending' account even with the correct password", async () => {
    mockFindUserByEmail.mockResolvedValue(activeUser({ status: "pending" }));
    mockVerifyPassword.mockResolvedValue(true);
    mockGetMembership.mockResolvedValue(membershipRow());

    await expect(authorizeCredentials("alice@sanjow.com", "correct-password", ORG_ID)).resolves.toBeNull();
  });

  it("never even checks membership for a pending account (fails closed before that lookup)", async () => {
    mockFindUserByEmail.mockResolvedValue(activeUser({ status: "pending" }));
    mockVerifyPassword.mockResolvedValue(true);

    await authorizeCredentials("alice@sanjow.com", "correct-password", ORG_ID);

    expect(mockGetMembership).not.toHaveBeenCalled();
  });

  it("rejects a 'suspended' account even with the correct password", async () => {
    mockFindUserByEmail.mockResolvedValue(activeUser({ status: "suspended" }));
    mockVerifyPassword.mockResolvedValue(true);
    mockGetMembership.mockResolvedValue(membershipRow());

    await expect(authorizeCredentials("alice@sanjow.com", "correct-password", ORG_ID)).resolves.toBeNull();
  });
});

describe("authorizeCredentials — every other failure reason is also just null", () => {
  it("no account with that email", async () => {
    mockFindUserByEmail.mockResolvedValue(null);
    await expect(authorizeCredentials("nobody@sanjow.com", "anything", ORG_ID)).resolves.toBeNull();
    // I6: verify IS run here (against a dummy hash) to equalise timing — see the
    // dedicated timing-oracle block below for why.
    expect(mockVerifyPassword).toHaveBeenCalled();
  });

  it("a Google-only account with no password set", async () => {
    mockFindUserByEmail.mockResolvedValue(activeUser({ passwordHash: null }));
    await expect(authorizeCredentials("alice@sanjow.com", "anything", ORG_ID)).resolves.toBeNull();
    // I6: also hashes against the dummy so a no-password account isn't a faster path.
    expect(mockVerifyPassword).toHaveBeenCalled();
  });

  it("wrong password", async () => {
    mockFindUserByEmail.mockResolvedValue(activeUser());
    mockVerifyPassword.mockResolvedValue(false);
    await expect(authorizeCredentials("alice@sanjow.com", "wrong-password", ORG_ID)).resolves.toBeNull();
  });

  it("correct password, active account, but no membership in the resolved org (tenant isolation)", async () => {
    mockFindUserByEmail.mockResolvedValue(activeUser());
    mockVerifyPassword.mockResolvedValue(true);
    mockGetMembership.mockResolvedValue(null);

    await expect(authorizeCredentials("alice@sanjow.com", "correct-password", "some-other-org")).resolves.toBeNull();
    expect(mockGetMembership).toHaveBeenCalledWith("user-1", "some-other-org");
  });

  it("empty email or password short-circuits before any lookup", async () => {
    await expect(authorizeCredentials("", "something", ORG_ID)).resolves.toBeNull();
    await expect(authorizeCredentials("alice@sanjow.com", "", ORG_ID)).resolves.toBeNull();
    expect(mockFindUserByEmail).not.toHaveBeenCalled();
  });
});

describe("authorizeCredentials — I6: timing is equalised (no user-enumeration oracle)", () => {
  it("the no-such-user path still runs one argon2 verify, against a valid PHC hash + the submitted password", async () => {
    mockFindUserByEmail.mockResolvedValue(null);

    await authorizeCredentials("nobody@sanjow.com", "submitted-pw", ORG_ID);

    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
    // A real argon2id PHC string (dummy), with the SUBMITTED password — the same
    // shape of work the real-user path does, so the branches can't be told apart
    // by response latency.
    expect(mockVerifyPassword).toHaveBeenCalledWith(
      expect.stringMatching(/^\$argon2id\$/),
      "submitted-pw",
    );
  });

  it("the Google-only (no hash) path also runs one verify against a valid PHC hash", async () => {
    mockFindUserByEmail.mockResolvedValue(activeUser({ passwordHash: null }));

    await authorizeCredentials("alice@sanjow.com", "submitted-pw", ORG_ID);

    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
    expect(mockVerifyPassword).toHaveBeenCalledWith(
      expect.stringMatching(/^\$argon2id\$/),
      "submitted-pw",
    );
  });

  it("the real-user path also runs exactly one verify (parity with the branches above)", async () => {
    mockFindUserByEmail.mockResolvedValue(activeUser());
    mockVerifyPassword.mockResolvedValue(false);

    await authorizeCredentials("alice@sanjow.com", "submitted-pw", ORG_ID);

    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
    expect(mockVerifyPassword).toHaveBeenCalledWith(
      "$argon2id$v=19$m=19456,t=2,p=1$salt$hash",
      "submitted-pw",
    );
  });
});
