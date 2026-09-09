// ============================================================================
// #30(a): requireRole × the REAL tenant resolver — an integration-style test.
// ----------------------------------------------------------------------------
// lib/authz.test.ts mocks @/lib/tenant's getCurrentOrgId to a vi.fn(), so it can
// only assert requireRole's behaviour GIVEN a resolved org — it can't prove what
// the real resolver hands it. This file leaves @/lib/tenant REAL and mocks only
// the leaf modules it dynamically imports (@/auth, @/lib/org, @/lib/membership,
// @/lib/users), so requireRole → getCurrentOrgId → resolveTenantOrgId runs
// end-to-end. The property under test: on a host/session mismatch, a caller who
// is NOT a member of the host org is authorized in their OWN session org, never
// the host org (the resolver never returns a host org the user isn't in — see
// lib/tenant.test.ts:~223 for the resolver-level proof; this is the composed,
// through-requireRole version the admin pages and actions actually rely on).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/org", () => ({
  getOrgById: vi.fn(),
  getOrgBySlug: vi.fn(),
  readOrgSlugHeader: vi.fn(),
  resolveOrgFromRequestHeader: vi.fn(),
  getFirstProjectIdForOrg: vi.fn(),
}));
vi.mock("@/lib/membership", () => ({
  getMembership: vi.fn(),
  determineRoleForNewMembership: vi.fn(),
  findOrCreateMembership: vi.fn(),
}));
vi.mock("@/lib/users", () => ({ findUserByEmail: vi.fn() }));

import { auth } from "@/auth";
import { getOrgById, getOrgBySlug, readOrgSlugHeader } from "@/lib/org";
import { getMembership } from "@/lib/membership";
import { findUserByEmail } from "@/lib/users";
import { requireRole } from "@/lib/authz";
import type { User } from "@/lib/users";
import type { Membership } from "@/lib/membership";
import type { MembershipRole } from "@/lib/roles";

type SessionGetter = () => Promise<Session | null>;
const mockAuth = vi.mocked(auth as unknown as SessionGetter);
const mockGetOrgById = vi.mocked(getOrgById);
const mockGetOrgBySlug = vi.mocked(getOrgBySlug);
const mockReadOrgSlugHeader = vi.mocked(readOrgSlugHeader);
const mockGetMembership = vi.mocked(getMembership);
const mockFindUserByEmail = vi.mocked(findUserByEmail);

const EMAIL = "user@acme.com";

function session(orgId: string): Session {
  return {
    expires: new Date(Date.now() + 60_000).toISOString(),
    orgId,
    user: { email: EMAIL },
  } as Session;
}

function user(): User {
  return {
    id: "u1",
    email: EMAIL,
    name: "User",
    image: null,
    passwordHash: null,
    emailVerifiedAt: null,
    status: "active",
    createdAt: new Date().toISOString(),
  };
}

function orgRow(id: string) {
  return { id, name: id, verifiedDomain: null, createdAt: new Date().toISOString() };
}

function membership(orgId: string, role: MembershipRole): Membership {
  return { userId: "u1", orgId, role, createdAt: new Date().toISOString() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUserByEmail.mockResolvedValue(user());
});

describe("requireRole with the real resolver — non-member of the host org", () => {
  it("authorizes the caller in their SESSION org, never the host org", async () => {
    // Signed into org-a; the request landed on org-b's host. The user is a member
    // of org-a only. The real resolver must keep org-a (never switch to org-b),
    // and requireRole must authorize the caller as their org-a role.
    mockAuth.mockResolvedValue(session("org-a"));
    mockReadOrgSlugHeader.mockResolvedValue("org-b"); // host names a DIFFERENT org
    mockGetOrgBySlug.mockResolvedValue(orgRow("org-b")); // ...which really exists
    mockGetMembership.mockImplementation(async (_userId: string, orgId: string) =>
      orgId === "org-a" ? membership("org-a", "admin") : null,
    );

    await expect(requireRole("admin")).resolves.toEqual({
      ok: true,
      userId: "u1",
      orgId: "org-a",
      role: "admin",
    });
    // Resolution probed the host org's membership (found none) and the authz
    // check ran against the session org — never granting the host org.
    expect(mockGetMembership).toHaveBeenCalledWith("u1", "org-b");
    expect(mockGetMembership).toHaveBeenCalledWith("u1", "org-a");
    expect(mockGetOrgById).not.toHaveBeenCalledWith("org-b");
  });

  it("resolves the session only ONCE per authorized call (#30 threading)", async () => {
    // requireRole resolves auth() up front and threads it into getCurrentOrgId,
    // so the resolver does not call auth() a second time for the same request.
    mockAuth.mockResolvedValue(session("org-a"));
    mockReadOrgSlugHeader.mockResolvedValue(null); // same-host fast path
    mockGetMembership.mockResolvedValue(membership("org-a", "viewer"));

    await expect(requireRole("viewer")).resolves.toMatchObject({ ok: true, orgId: "org-a" });
    expect(mockAuth).toHaveBeenCalledTimes(1);
  });
});

describe("requireRole with the real resolver — member of the host org", () => {
  it("switches to the HOST org and authorizes at the host-org role", async () => {
    // Signed into org-a, but a member of org-b too, and the request is on org-b's
    // host → the resolver switches to org-b, and requireRole authorizes the
    // caller with their org-b role (a viewer of B, even if an owner of A).
    mockAuth.mockResolvedValue(session("org-a"));
    mockReadOrgSlugHeader.mockResolvedValue("org-b");
    mockGetOrgBySlug.mockResolvedValue(orgRow("org-b"));
    mockGetMembership.mockImplementation(async (_userId: string, orgId: string) =>
      orgId === "org-b" ? membership("org-b", "viewer") : membership("org-a", "owner"),
    );

    await expect(requireRole("viewer")).resolves.toEqual({
      ok: true,
      userId: "u1",
      orgId: "org-b",
      role: "viewer",
    });
    // Owner of A must NOT get admin/owner powers while acting on B's host.
    await expect(requireRole("admin")).resolves.toMatchObject({ ok: false, status: 403 });
  });
});
