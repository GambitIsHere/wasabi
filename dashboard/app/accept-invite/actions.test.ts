// ============================================================================
// acceptInviteAsNewUser — behavioural tests for the create-account-on-accept
// path (Task C).
// ----------------------------------------------------------------------------
// This is the security-sensitive half of the accept flow: it creates an
// ACTIVE account that bypasses /api/register's domain restriction, authorized
// ONLY by a valid single-use invite. Every invariant the spec calls out is
// covered here.
//
// Mocking follows this codebase's convention (app/actions.test.ts,
// lib/credentials-auth.test.ts): the DB-touching dependencies are mocked, the
// PURE decision logic is left real. Concretely:
//   - @/lib/invitations: getInvitationByToken + acceptInvitation are mocked
//     (they own SQL); invitationStatus / emailMatchesInvitation stay REAL, so
//     the status branches below exercise the actual status logic.
//   - @/lib/users: findUserByEmail + createUser are mocked; normalizeEmail +
//     isUniqueViolation stay REAL (the real email lowercasing and the real
//     23505 classification are part of what this test asserts).
//   - @/lib/password: hashPassword is mocked (no argon2 in unit tests);
//     validatePasswordStrength stays REAL (from the pure policy module), so
//     the weak-password test hits the real policy.
//   - @/auth: mocked to a stub so importing the actions module doesn't spin up
//     NextAuth (the module imports it for the sibling acceptInviteAction).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/invitations", async () => {
  const actual = await vi.importActual<typeof import("@/lib/invitations")>("@/lib/invitations");
  return { ...actual, getInvitationByToken: vi.fn(), acceptInvitation: vi.fn() };
});
vi.mock("@/lib/users", async () => {
  const actual = await vi.importActual<typeof import("@/lib/users")>("@/lib/users");
  return {
    ...actual,
    findUserByEmail: vi.fn(),
    createUser: vi.fn(),
    deleteUser: vi.fn(),
    setUserStatus: vi.fn(),
  };
});
vi.mock("@/lib/password", async () => {
  const policy = await vi.importActual<typeof import("@/lib/password-policy")>("@/lib/password-policy");
  return { ...policy, hashPassword: vi.fn(async () => "argon2-hash-stub") };
});

import { acceptInviteAsNewUser, acceptInviteAsPendingUser } from "@/app/accept-invite/actions";
import { acceptInvitation, getInvitationByToken } from "@/lib/invitations";
import type { Invitation } from "@/lib/invitations";
import { createUser, deleteUser, findUserByEmail, setUserStatus } from "@/lib/users";
import { hashPassword } from "@/lib/password";
import type { User } from "@/lib/users";

const mockGetInvitationByToken = vi.mocked(getInvitationByToken);
const mockAcceptInvitation = vi.mocked(acceptInvitation);
const mockFindUserByEmail = vi.mocked(findUserByEmail);
const mockCreateUser = vi.mocked(createUser);
const mockDeleteUser = vi.mocked(deleteUser);
const mockSetUserStatus = vi.mocked(setUserStatus);
const mockHashPassword = vi.mocked(hashPassword);

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// Off-domain on purpose — the whole reason this path exists. A password that
// clears the REAL strength policy (12+, not sequential/repeated/common, not
// the email).
const INVITED_EMAIL = "consultant@totally-unrelated-domain.io";
const STRONG_PASSWORD = "Wasabi-Cockpit-77";

function invitation(overrides: Partial<Invitation> = {}): Invitation {
  const now = Date.now();
  return {
    id: "inv-1",
    orgId: "sanjow",
    email: INVITED_EMAIL,
    role: "editor",
    tokenHash: "hash",
    tokenPrefix: "abcd1234",
    invitedBy: "admin-1",
    createdAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + SEVEN_DAYS_MS).toISOString(),
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function createdUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-new",
    email: INVITED_EMAIL,
    name: null,
    image: null,
    passwordHash: "argon2-hash-stub",
    emailVerifiedAt: null,
    status: "active",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHashPassword.mockResolvedValue("argon2-hash-stub");
  // clearAllMocks resets call history but NOT implementations — re-establish a
  // stable default so one test's mockRejectedValue can't leak into the next.
  mockDeleteUser.mockResolvedValue(true);
  mockSetUserStatus.mockResolvedValue(createdUser({ id: "user-pending", status: "active" }));
});

describe("acceptInviteAsNewUser — happy path (a brand-new, off-domain account)", () => {
  it("creates an ACTIVE account and grants membership, returning acceptInvitation's ok result", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation({ role: "editor", orgId: "sanjow" }));
    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(createdUser({ id: "user-new" }));
    mockAcceptInvitation.mockResolvedValue({ ok: true, orgId: "sanjow", role: "editor" });

    const result = await acceptInviteAsNewUser("raw-token", {
      name: "Casey Consultant",
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    });

    expect(result).toEqual({ ok: true, orgId: "sanjow", role: "editor" });

    // 🔴 status is "active" (not "pending" like /api/register) — an admin
    // already approved this person by inviting them.
    expect(mockCreateUser).toHaveBeenCalledTimes(1);
    const createArg = mockCreateUser.mock.calls[0][0];
    expect(createArg.status).toBe("active");
    // 🔴 email comes from the INVITE record, never the form.
    expect(createArg.email).toBe(INVITED_EMAIL);
    expect(createArg.name).toBe("Casey Consultant");
    // Password is hashed, never stored raw.
    expect(mockHashPassword).toHaveBeenCalledWith(STRONG_PASSWORD);
    expect(createArg.passwordHash).toBe("argon2-hash-stub");
  });

  it("🔴 the created account satisfies credentials-auth's gate: status active + a membership grant", async () => {
    // credentials-auth requires (status === "active") AND getMembership() non-null.
    // This action sets the first directly (createUser status) and produces the
    // second by calling acceptInvitation with the created user's id/email —
    // which is exactly the membership grant (lib/invitations.ts).
    mockGetInvitationByToken.mockResolvedValue(invitation({ orgId: "sanjow", role: "admin" }));
    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(createdUser({ id: "user-new", email: INVITED_EMAIL }));
    mockAcceptInvitation.mockResolvedValue({ ok: true, orgId: "sanjow", role: "admin" });

    await acceptInviteAsNewUser("raw-token", { password: STRONG_PASSWORD, confirmPassword: STRONG_PASSWORD });

    expect(mockCreateUser.mock.calls[0][0].status).toBe("active");
    expect(mockAcceptInvitation).toHaveBeenCalledWith("raw-token", {
      id: "user-new",
      email: INVITED_EMAIL,
    });
  });

  it("🔴 role and org come from the invite (via acceptInvitation), never the form", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation({ orgId: "acme", role: "viewer" }));
    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(createdUser());
    mockAcceptInvitation.mockResolvedValue({ ok: true, orgId: "acme", role: "viewer" });

    const result = await acceptInviteAsNewUser("raw-token", {
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    });

    expect(result).toEqual({ ok: true, orgId: "acme", role: "viewer" });
  });

  it("an omitted name is stored as null (not an empty string)", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(createdUser());
    mockAcceptInvitation.mockResolvedValue({ ok: true, orgId: "sanjow", role: "editor" });

    await acceptInviteAsNewUser("raw-token", {
      name: "   ",
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    });

    expect(mockCreateUser.mock.calls[0][0].name).toBeNull();
  });
});

describe("acceptInviteAsNewUser — the token must be valid + pending BEFORE any write", () => {
  it("an unknown/invalid token is rejected and creates NO user", async () => {
    mockGetInvitationByToken.mockResolvedValue(null);

    const result = await acceptInviteAsNewUser("bad-token", {
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    });

    expect(result).toEqual({ ok: false, reason: "This invitation link is invalid." });
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockAcceptInvitation).not.toHaveBeenCalled();
  });

  it("🔴 single-use: an already-accepted invite is rejected, no user created", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation({ acceptedAt: new Date().toISOString() }));

    const result = await acceptInviteAsNewUser("used-token", {
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    });

    expect(result).toEqual({ ok: false, reason: "This invitation has already been used." });
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it("an expired invite is rejected, no user created", async () => {
    mockGetInvitationByToken.mockResolvedValue(
      invitation({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    );

    const result = await acceptInviteAsNewUser("expired-token", {
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    });

    expect(result).toEqual({ ok: false, reason: "This invitation has expired." });
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it("a revoked invite is rejected, no user created", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation({ revokedAt: new Date().toISOString() }));

    const result = await acceptInviteAsNewUser("revoked-token", {
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    });

    expect(result).toEqual({ ok: false, reason: "This invitation has been revoked." });
    expect(mockCreateUser).not.toHaveBeenCalled();
  });
});

describe("acceptInviteAsNewUser — never duplicate or overwrite an existing account", () => {
  it("🔴 rejects when the invited email already has an account — no dup, no password write", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(createdUser({ id: "existing-user" }));

    const result = await acceptInviteAsNewUser("raw-token", {
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    });

    expect(result).toEqual({ ok: false, reason: "This email already has an account. Sign in instead." });
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockAcceptInvitation).not.toHaveBeenCalled();
  });

  it("🔴 a concurrent signup (unique violation on insert) falls back to the same 'already has an account' result", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(null); // clear at check time
    mockCreateUser.mockRejectedValue({ code: "23505", message: "duplicate key value violates unique constraint" });

    const result = await acceptInviteAsNewUser("raw-token", {
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    });

    expect(result).toEqual({ ok: false, reason: "This email already has an account. Sign in instead." });
    // The invite is never consumed for a signup that didn't actually create a user.
    expect(mockAcceptInvitation).not.toHaveBeenCalled();
  });

  it("a non-unique-violation DB error is NOT swallowed (it rethrows)", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockRejectedValue(new Error("connection reset"));

    await expect(
      acceptInviteAsNewUser("raw-token", { password: STRONG_PASSWORD, confirmPassword: STRONG_PASSWORD }),
    ).rejects.toThrow("connection reset");
  });
});

describe("acceptInviteAsNewUser — password checks are enforced SERVER-SIDE", () => {
  it("rejects mismatched passwords before any strength check or write", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(null);

    const result = await acceptInviteAsNewUser("raw-token", {
      password: STRONG_PASSWORD,
      confirmPassword: "something-else-entirely",
    });

    expect(result).toEqual({ ok: false, reason: "Passwords don't match." });
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it("🔴 rejects a weak password (real strength policy), no user created", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(null);

    const result = await acceptInviteAsNewUser("raw-token", {
      password: "short",
      confirmPassword: "short",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/at least 12 characters/i);
    }
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it("rejects a common/sequential password even at full length", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(null);

    const result = await acceptInviteAsNewUser("raw-token", {
      password: "123456789012",
      confirmPassword: "123456789012",
    });

    expect(result.ok).toBe(false);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });
});

describe("acceptInviteAsNewUser — orphan-account rollback when the invite races after createUser", () => {
  it("🔴 deletes the just-created user and returns acceptInvitation's ok:false verbatim", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(createdUser({ id: "user-new" }));
    mockAcceptInvitation.mockResolvedValue({
      ok: false,
      reason: "This invitation was just used or revoked — it's no longer available.",
    });

    const result = await acceptInviteAsNewUser("raw-token", {
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    });

    // Compensating rollback: the orphan is removed so the email returns to
    // pristine and a re-invite works normally (findUserByEmail null again).
    expect(mockDeleteUser).toHaveBeenCalledWith("user-new");
    expect(result).toEqual({
      ok: false,
      reason: "This invitation was just used or revoked — it's no longer available.",
    });
  });

  it("if the compensating delete itself throws, still returns the original acceptInvitation failure (never masks it)", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(createdUser({ id: "user-new" }));
    mockAcceptInvitation.mockResolvedValue({ ok: false, reason: "This invitation has been revoked." });
    mockDeleteUser.mockRejectedValue(new Error("delete failed"));

    const result = await acceptInviteAsNewUser("raw-token", {
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    });

    expect(mockDeleteUser).toHaveBeenCalledWith("user-new");
    expect(result).toEqual({ ok: false, reason: "This invitation has been revoked." });
  });

  it("on SUCCESS, never deletes the created user", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(createdUser());
    mockAcceptInvitation.mockResolvedValue({ ok: true, orgId: "sanjow", role: "editor" });

    await acceptInviteAsNewUser("raw-token", { password: STRONG_PASSWORD, confirmPassword: STRONG_PASSWORD });

    expect(mockDeleteUser).not.toHaveBeenCalled();
  });
});

describe("acceptInviteAsNewUser — field length caps are enforced BEFORE hashing", () => {
  it("🔴 rejects an over-long password without hashing (no argon2 grind) and creates no user", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(null);
    const longPassword = "aB3xY9zQ".repeat(30); // 240 chars — clears the 12-char floor

    const result = await acceptInviteAsNewUser("raw-token", {
      password: longPassword,
      confirmPassword: longPassword,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/200 characters or fewer/i);
    expect(mockHashPassword).not.toHaveBeenCalled();
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it("rejects an over-long name and creates no user", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(null);

    const result = await acceptInviteAsNewUser("raw-token", {
      name: "n".repeat(201),
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/name must be 200 characters or fewer/i);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it("accepts a password at exactly the 200-char cap", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(createdUser());
    mockAcceptInvitation.mockResolvedValue({ ok: true, orgId: "sanjow", role: "editor" });
    const exactly200 = "aB3".repeat(66) + "xy"; // 200 chars, mixed, not sequential/common

    const result = await acceptInviteAsNewUser("raw-token", {
      password: exactly200,
      confirmPassword: exactly200,
    });

    expect(result.ok).toBe(true);
    expect(mockCreateUser).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// acceptInviteAsPendingUser — the ACTIVATE-ON-ACCEPT path (issue #25).
// ----------------------------------------------------------------------------
// A self-registered `pending` account that is then invited: redemption is the
// approval. The invariant under test — an account is activated + granted ONLY
// via a valid, unredeemed, unexpired invite for that EXACT email, claimed
// before activation.
// ============================================================================
function pendingUser(overrides: Partial<User> = {}): User {
  return createdUser({ id: "user-pending", email: INVITED_EMAIL, status: "pending", ...overrides });
}

describe("acceptInviteAsPendingUser — happy path (invite activates a pending account)", () => {
  it("🔴 claims the invite, then activates the account, returning acceptInvitation's ok result", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation({ orgId: "sanjow", role: "editor" }));
    mockFindUserByEmail.mockResolvedValue(pendingUser());
    mockAcceptInvitation.mockResolvedValue({ ok: true, orgId: "sanjow", role: "editor" });

    const result = await acceptInviteAsPendingUser("raw-token");

    expect(result).toEqual({ ok: true, orgId: "sanjow", role: "editor" });
    // Membership is granted for the invited account's own id/email …
    expect(mockAcceptInvitation).toHaveBeenCalledWith("raw-token", {
      id: "user-pending",
      email: INVITED_EMAIL,
    });
    // … and only then is the account flipped pending → active.
    expect(mockSetUserStatus).toHaveBeenCalledWith("user-pending", "active");
  });

  it("🔴 the account is NEVER created here — this path only activates an existing one", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(pendingUser());
    mockAcceptInvitation.mockResolvedValue({ ok: true, orgId: "sanjow", role: "editor" });

    await acceptInviteAsPendingUser("raw-token");

    expect(mockCreateUser).not.toHaveBeenCalled();
  });
});

describe("acceptInviteAsPendingUser — no activation without a valid, pending invite", () => {
  it("an unknown/invalid token activates nothing", async () => {
    mockGetInvitationByToken.mockResolvedValue(null);

    const result = await acceptInviteAsPendingUser("bad-token");

    expect(result).toEqual({ ok: false, reason: "This invitation link is invalid." });
    expect(mockFindUserByEmail).not.toHaveBeenCalled();
    expect(mockAcceptInvitation).not.toHaveBeenCalled();
    expect(mockSetUserStatus).not.toHaveBeenCalled();
  });

  it("🔴 an already-used invite activates nothing (single-use)", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation({ acceptedAt: new Date().toISOString() }));

    const result = await acceptInviteAsPendingUser("used-token");

    expect(result).toEqual({ ok: false, reason: "This invitation has already been used." });
    expect(mockAcceptInvitation).not.toHaveBeenCalled();
    expect(mockSetUserStatus).not.toHaveBeenCalled();
  });

  it("an expired invite activates nothing", async () => {
    mockGetInvitationByToken.mockResolvedValue(
      invitation({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    );

    const result = await acceptInviteAsPendingUser("expired-token");

    expect(result).toEqual({ ok: false, reason: "This invitation has expired." });
    expect(mockSetUserStatus).not.toHaveBeenCalled();
  });

  it("a revoked invite activates nothing", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation({ revokedAt: new Date().toISOString() }));

    const result = await acceptInviteAsPendingUser("revoked-token");

    expect(result).toEqual({ ok: false, reason: "This invitation has been revoked." });
    expect(mockSetUserStatus).not.toHaveBeenCalled();
  });

  it("🔴 a claim lost to a race (acceptInvitation ok:false) activates nothing", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(pendingUser());
    mockAcceptInvitation.mockResolvedValue({
      ok: false,
      reason: "This invitation was just used or revoked — it's no longer available.",
    });

    const result = await acceptInviteAsPendingUser("raw-token");

    expect(result).toEqual({
      ok: false,
      reason: "This invitation was just used or revoked — it's no longer available.",
    });
    // The claim ran, but it did not win — so the account is left pending.
    expect(mockSetUserStatus).not.toHaveBeenCalled();
  });
});

describe("acceptInviteAsPendingUser — only ever touches a pending account", () => {
  it("does nothing when the invited email has no account at all", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(null);

    const result = await acceptInviteAsPendingUser("raw-token");

    expect(result.ok).toBe(false);
    expect(mockAcceptInvitation).not.toHaveBeenCalled();
    expect(mockSetUserStatus).not.toHaveBeenCalled();
  });

  it("🔴 refuses an active account (that's the signed-in confirm path, not this one)", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(pendingUser({ status: "active" }));

    const result = await acceptInviteAsPendingUser("raw-token");

    expect(result.ok).toBe(false);
    expect(mockAcceptInvitation).not.toHaveBeenCalled();
    expect(mockSetUserStatus).not.toHaveBeenCalled();
  });

  it("🔴 refuses a suspended account — an invite never reactivates it", async () => {
    mockGetInvitationByToken.mockResolvedValue(invitation());
    mockFindUserByEmail.mockResolvedValue(pendingUser({ status: "suspended" }));

    const result = await acceptInviteAsPendingUser("raw-token");

    expect(result.ok).toBe(false);
    expect(mockAcceptInvitation).not.toHaveBeenCalled();
    expect(mockSetUserStatus).not.toHaveBeenCalled();
  });
});
