// ============================================================================
// lib/superadmin.test.ts — the cross-org super-admin gate must:
//   • authorize only Sanjow platform operators,
//   • refuse a normal org owner (incl. another org's owner) so no cross-org
//     data is ever reachable,
//   • re-derive everything from the DB (never the JWT), refuse suspended/pending,
//   • honour the explicit WASABI_SUPERADMIN_EMAILS allowlist over the fallback.
// DB-touching deps are mocked (this codebase's DB-free unit-test convention —
// same vi.mock pattern as authz.test.ts); lib/roles + lib/tenant stay real (pure).
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/users", () => ({ findUserByEmail: vi.fn() }));
vi.mock("@/lib/membership", () => ({ getMembership: vi.fn() }));

import { auth } from "@/auth";
import { findUserByEmail } from "@/lib/users";
import { getMembership } from "@/lib/membership";
import {
  isEmailAllowlisted,
  parseSuperAdminAllowlist,
  requireSuperAdmin,
} from "@/lib/superadmin";
import type { User } from "@/lib/users";
import type { Membership } from "@/lib/membership";
import type { MembershipRole } from "@/lib/roles";

type SessionGetter = () => Promise<Session | null>;
const mockAuth = vi.mocked(auth as unknown as SessionGetter);
const mockFindUserByEmail = vi.mocked(findUserByEmail);
const mockGetMembership = vi.mocked(getMembership);

const SANJOW = "sanjow";
const EMAIL = "alice@sanjow.com";

function session(overrides: Partial<Session> = {}): Session {
  return {
    expires: new Date(Date.now() + 60_000).toISOString(),
    user: { email: EMAIL },
    orgId: SANJOW,
    ...overrides,
  } as Session;
}

function user(overrides: Partial<User> = {}): User {
  return {
    id: "u1",
    email: EMAIL,
    name: "Alice",
    image: null,
    passwordHash: null,
    emailVerifiedAt: null,
    status: "active",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function membership(orgId: string, role: MembershipRole): Membership {
  return { userId: "u1", orgId, role, createdAt: new Date().toISOString() };
}

// Each test controls the env keys the gate reads via vi.stubEnv (which also
// handles NODE_ENV, a read-only literal type); vi.unstubAllEnvs restores them.
beforeEach(() => {
  vi.clearAllMocks();
  // Deterministic default: no allowlist, no dev bypass, not production.
  vi.stubEnv("WASABI_SUPERADMIN_EMAILS", undefined);
  vi.stubEnv("WASABI_DEV_NO_AUTH", undefined);
  vi.stubEnv("VERCEL", undefined);
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseSuperAdminAllowlist / isEmailAllowlisted (pure)", () => {
  it("splits on commas and whitespace, trims, lowercases, drops blanks", () => {
    expect(parseSuperAdminAllowlist("A@x.com, b@x.com\n  c@x.com ,,")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
    ]);
  });

  it("treats unset / empty as an empty list (never a match)", () => {
    expect(parseSuperAdminAllowlist(undefined)).toEqual([]);
    expect(parseSuperAdminAllowlist("")).toEqual([]);
    expect(parseSuperAdminAllowlist("   ")).toEqual([]);
    expect(isEmailAllowlisted("a@x.com", undefined)).toBe(false);
    expect(isEmailAllowlisted("a@x.com", "")).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(isEmailAllowlisted("Alice@Sanjow.com", "alice@sanjow.com")).toBe(true);
    expect(isEmailAllowlisted("bob@x.com", "alice@sanjow.com")).toBe(false);
  });
});

describe("requireSuperAdmin — authentication", () => {
  it("no session → 401 (and no DB lookup)", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: false, status: 401 });
    expect(mockFindUserByEmail).not.toHaveBeenCalled();
  });

  it("session without an email → 401", async () => {
    mockAuth.mockResolvedValue(session({ user: {} }));
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: false, status: 401 });
  });
});

describe("requireSuperAdmin — live account status", () => {
  it("a suspended account is refused (403)", async () => {
    vi.stubEnv("WASABI_SUPERADMIN_EMAILS", EMAIL);
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user({ status: "suspended" }));
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: false, status: 403 });
  });

  it("a pending account is refused (403)", async () => {
    vi.stubEnv("WASABI_SUPERADMIN_EMAILS", EMAIL);
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user({ status: "pending" }));
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: false, status: 403 });
  });

  it("an unknown user (no DB row) is refused (403)", async () => {
    vi.stubEnv("WASABI_SUPERADMIN_EMAILS", EMAIL);
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(null);
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: false, status: 403 });
  });
});

describe("requireSuperAdmin — allowlist is authoritative when configured", () => {
  it("an allowlisted active operator is authorized (via allowlist)", async () => {
    vi.stubEnv("WASABI_SUPERADMIN_EMAILS", "ops@sanjow.com, alice@sanjow.com");
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    await expect(requireSuperAdmin()).resolves.toEqual({
      ok: true,
      userId: "u1",
      email: EMAIL,
      via: "allowlist",
    });
    // Allowlist wins outright — the membership fallback is never consulted.
    expect(mockGetMembership).not.toHaveBeenCalled();
  });

  it("🔴 an active user NOT on the allowlist is refused — even a Sanjow owner", async () => {
    vi.stubEnv("WASABI_SUPERADMIN_EMAILS", "someone-else@sanjow.com");
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    // Would be an owner of the Sanjow org, but the allowlist doesn't list them.
    mockGetMembership.mockResolvedValue(membership(SANJOW, "owner"));
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: false, status: 403 });
    expect(mockGetMembership).not.toHaveBeenCalled();
  });
});

describe("requireSuperAdmin — allowlist path runs through isEmailAllowlisted", () => {
  // The gate's own real path (not just the pure helper): the follow-up to #14
  // routes the allowlist branch through isEmailAllowlisted, so requireSuperAdmin
  // can never silently diverge from that tested helper.
  it("an allowlisted active user passes (via allowlist)", async () => {
    vi.stubEnv("WASABI_SUPERADMIN_EMAILS", EMAIL);
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: true, via: "allowlist" });
  });

  it("🔴 a non-allowlisted active user is refused even when they would be a Sanjow owner", async () => {
    // Allowlist is authoritative: a would-be Sanjow owner not on it is refused,
    // and the membership fallback is never consulted.
    vi.stubEnv("WASABI_SUPERADMIN_EMAILS", "ops@sanjow.com");
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(membership(SANJOW, "owner"));
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: false, status: 403 });
    expect(mockGetMembership).not.toHaveBeenCalled();
  });

  it("matches case-insensitively through the gate (mixed-case account email, lowercase allowlist)", async () => {
    // A mixed-case account email must still clear a lowercase allowlist — the
    // pre-fix inline `allowlist.includes(dbUser.email)` compared the lowercased
    // list against a non-lowercased email and would have missed this.
    vi.stubEnv("WASABI_SUPERADMIN_EMAILS", "alice@sanjow.com");
    mockAuth.mockResolvedValue(session({ user: { email: "Alice@Sanjow.com" } }));
    mockFindUserByEmail.mockResolvedValue(user({ email: "Alice@Sanjow.com" }));
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: true, via: "allowlist" });
  });
});

describe("requireSuperAdmin — fallback: active owner/admin of the Sanjow org", () => {
  it("a Sanjow owner is authorized (via sanjow-admin)", async () => {
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(membership(SANJOW, "owner"));
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: true, via: "sanjow-admin" });
    expect(mockGetMembership).toHaveBeenCalledWith("u1", SANJOW);
  });

  it("a Sanjow admin is authorized", async () => {
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(membership(SANJOW, "admin"));
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: true, via: "sanjow-admin" });
  });

  it("🔴 a Sanjow editor is refused (below admin)", async () => {
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(membership(SANJOW, "editor"));
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: false, status: 403 });
  });

  it("🔴 a Sanjow viewer is refused", async () => {
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(membership(SANJOW, "viewer"));
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: false, status: 403 });
  });

  it("🔴 ANOTHER org's owner is refused — no membership in the Sanjow org", async () => {
    // The tell of the whole gate: getMembership(user, SANJOW) returns null for
    // someone whose only owner role is in a different tenant → no cross-org view.
    mockAuth.mockResolvedValue(session({ orgId: "acme", user: { email: "boss@acme.com" } }));
    mockFindUserByEmail.mockResolvedValue(user({ email: "boss@acme.com" }));
    mockGetMembership.mockResolvedValue(null);
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: false, status: 403 });
    expect(mockGetMembership).toHaveBeenCalledWith("u1", SANJOW);
  });
});

describe("requireSuperAdmin — local-dev bypass (guarded)", () => {
  it("authorizes without any session when WASABI_DEV_NO_AUTH=1 in local dev", async () => {
    vi.stubEnv("WASABI_DEV_NO_AUTH", "1");
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("NODE_ENV", "development");
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: true, via: "dev-bypass" });
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("does NOT bypass in a Vercel/production environment", async () => {
    vi.stubEnv("WASABI_DEV_NO_AUTH", "1");
    vi.stubEnv("VERCEL", "1");
    mockAuth.mockResolvedValue(null);
    await expect(requireSuperAdmin()).resolves.toMatchObject({ ok: false, status: 401 });
  });
});
