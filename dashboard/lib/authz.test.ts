// ============================================================================
// authz.ts — C4/I8: requireRole must re-derive the caller's role from the DB
// (never the JWT), deny anyone below the minimum, deny a suspended account
// immediately, and handle the live-Sanjow migration (lazy membership) without
// bricking the tool. DB-touching deps are mocked (this codebase's DB-free
// unit-test convention — same vi.mock pattern as tenant.test.ts /
// credentials-auth.test.ts); lib/roles + lib/domain-restriction stay real
// (pure).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/users", () => ({ findUserByEmail: vi.fn() }));
vi.mock("@/lib/membership", () => ({
  getMembership: vi.fn(),
  determineRoleForNewMembership: vi.fn(),
  findOrCreateMembership: vi.fn(),
}));
vi.mock("@/lib/org", () => ({ getOrgById: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getCurrentOrgId: vi.fn() }));

import { auth } from "@/auth";
import { findUserByEmail } from "@/lib/users";
import {
  determineRoleForNewMembership,
  findOrCreateMembership,
  getMembership,
} from "@/lib/membership";
import { getOrgById } from "@/lib/org";
import { getCurrentOrgId } from "@/lib/tenant";
import { requireRole } from "@/lib/authz";
import type { User } from "@/lib/users";
import type { Membership } from "@/lib/membership";
import type { MembershipRole } from "@/lib/roles";

type SessionGetter = () => Promise<Session | null>;
const mockAuth = vi.mocked(auth as unknown as SessionGetter);
const mockFindUserByEmail = vi.mocked(findUserByEmail);
const mockGetMembership = vi.mocked(getMembership);
const mockDetermineRole = vi.mocked(determineRoleForNewMembership);
const mockFindOrCreateMembership = vi.mocked(findOrCreateMembership);
const mockGetOrgById = vi.mocked(getOrgById);
const mockGetCurrentOrgId = vi.mocked(getCurrentOrgId);

const ORG = "sanjow";
const EMAIL = "alice@sanjow.com";

function session(overrides: Partial<Session> = {}): Session {
  return {
    expires: new Date(Date.now() + 60_000).toISOString(),
    user: { email: EMAIL },
    orgId: ORG,
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

function membership(role: MembershipRole): Membership {
  return { userId: "u1", orgId: ORG, role, createdAt: new Date().toISOString() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireRole — authentication", () => {
  it("no session → 401", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(requireRole("viewer")).resolves.toMatchObject({ ok: false, status: 401 });
  });

  it("session without an email → 401", async () => {
    mockAuth.mockResolvedValue(session({ user: {} }));
    await expect(requireRole("viewer")).resolves.toMatchObject({ ok: false, status: 401 });
  });
});

describe("requireRole — role re-derived from the membership table", () => {
  it("🔴 a viewer is REJECTED (403) for an admin-gated verb", async () => {
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(membership("viewer"));

    await expect(requireRole("admin")).resolves.toMatchObject({ ok: false, status: 403 });
  });

  it("a viewer still passes a viewer-level check", async () => {
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(membership("viewer"));

    await expect(requireRole("viewer")).resolves.toEqual({
      ok: true,
      userId: "u1",
      orgId: ORG,
      role: "viewer",
    });
  });

  it("an editor passes editor but is rejected for admin", async () => {
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(membership("editor"));

    await expect(requireRole("editor")).resolves.toMatchObject({ ok: true, role: "editor" });
    await expect(requireRole("admin")).resolves.toMatchObject({ ok: false, status: 403 });
  });

  it("an owner passes the most-privileged (owner) check", async () => {
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(membership("owner"));

    await expect(requireRole("owner")).resolves.toMatchObject({ ok: true, role: "owner" });
  });

  it("the role comes from the DB membership, NOT the (possibly stale) session claim", async () => {
    // Session says owner, but the live membership says viewer → deny.
    mockAuth.mockResolvedValue(session({ role: "owner" }));
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(membership("viewer"));

    await expect(requireRole("admin")).resolves.toMatchObject({ ok: false, status: 403 });
  });
});

describe("requireRole — live status re-check (I8)", () => {
  it("a suspended account is denied immediately, before any membership lookup", async () => {
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user({ status: "suspended" }));

    await expect(requireRole("viewer")).resolves.toMatchObject({ ok: false, status: 403 });
    expect(mockGetMembership).not.toHaveBeenCalled();
  });

  it("a pending account is denied", async () => {
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user({ status: "pending" }));

    await expect(requireRole("viewer")).resolves.toMatchObject({ ok: false, status: 403 });
  });
});

describe("requireRole — migration safety (no membership row yet)", () => {
  it("lazily provisions a membership for an active, domain-matched caller and authorizes at that role", async () => {
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(null); // no row yet — the live-Sanjow transition
    mockGetOrgById.mockResolvedValue({
      id: ORG,
      name: "Sanjow",
      verifiedDomain: "sanjow.com",
      createdAt: new Date().toISOString(),
    });
    mockDetermineRole.mockResolvedValue("owner"); // first active member of the org
    mockFindOrCreateMembership.mockResolvedValue(membership("owner"));

    await expect(requireRole("admin")).resolves.toMatchObject({ ok: true, role: "owner" });
    expect(mockFindOrCreateMembership).toHaveBeenCalledWith("u1", ORG, "owner");
  });

  it("does NOT provision (and denies) when the caller's email is off the org's verified domain", async () => {
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(null);
    mockGetOrgById.mockResolvedValue({
      id: ORG,
      name: "Sanjow",
      verifiedDomain: "someone-else.com", // alice@sanjow.com does NOT match
      createdAt: new Date().toISOString(),
    });

    await expect(requireRole("viewer")).resolves.toMatchObject({ ok: false, status: 403 });
    expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
  });
});

describe("requireRole — pre-migration token (no session.orgId)", () => {
  it("falls back to subdomain org resolution rather than failing", async () => {
    mockAuth.mockResolvedValue(session({ orgId: undefined }));
    mockGetCurrentOrgId.mockResolvedValue(ORG);
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(membership("admin"));

    await expect(requireRole("admin")).resolves.toMatchObject({ ok: true, role: "admin" });
    expect(mockGetCurrentOrgId).toHaveBeenCalled();
    expect(mockGetMembership).toHaveBeenCalledWith("u1", ORG);
  });
});
