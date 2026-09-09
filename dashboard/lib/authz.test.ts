// ============================================================================
// authz.ts — C4/I8: requireRole must re-derive the caller's role from the DB
// (never the JWT), deny anyone below the minimum, deny a suspended account
// immediately, and handle the live-Sanjow migration (lazy membership) without
// bricking the tool. DB-touching deps are mocked (this codebase's DB-free
// unit-test convention — same vi.mock pattern as tenant.test.ts /
// credentials-auth.test.ts); lib/roles + lib/domain-restriction stay real
// (pure).
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/users", () => ({ findUserByEmail: vi.fn() }));
vi.mock("@/lib/membership", () => ({
  getMembership: vi.fn(),
  determineRoleForNewMembership: vi.fn(),
  findOrCreateMembership: vi.fn(),
}));
vi.mock("@/lib/org", () => ({ getOrgById: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getCurrentOrgId: vi.fn(), SANJOW_ORG_ID: "sanjow" }));

import { auth } from "@/auth";
import { findUserByEmail } from "@/lib/users";
import {
  determineRoleForNewMembership,
  findOrCreateMembership,
  getMembership,
} from "@/lib/membership";
import { getOrgById } from "@/lib/org";
import { getCurrentOrgId } from "@/lib/tenant";
import { DEV_NO_AUTH_USER_ID, requireRole } from "@/lib/authz";
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
  // Common case: the request's Host resolves to the caller's own org, so the
  // host-switch-aware getCurrentOrgId returns the session org. Individual tests
  // override this to exercise a genuine host-switch (a different resolved org).
  mockGetCurrentOrgId.mockResolvedValue(ORG);
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  it("#28 owner-claim: does NOT provision (or bootstrap owner) off the global AUTH_ALLOWED_EMAIL_DOMAIN when the org has no verified_domain", async () => {
    // The dropped vector: a domain-LESS org while the global env domain is still
    // set in prod. Under the old `?? process.env.AUTH_ALLOWED_EMAIL_DOMAIN`
    // fallback, alice@sanjow.com matched the env "sanjow.com" and — being the
    // first active member — was bootstrapped to OWNER of an org she never
    // belonged to. With the env fallback gone, a null verified_domain provisions
    // nobody: no membership, no owner-bootstrap, denied.
    vi.stubEnv("AUTH_ALLOWED_EMAIL_DOMAIN", "sanjow.com");
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(null);
    mockGetOrgById.mockResolvedValue({
      id: ORG,
      name: "Domainless Org",
      verifiedDomain: null, // the vulnerable case
      createdAt: new Date().toISOString(),
    });

    await expect(requireRole("admin")).resolves.toMatchObject({ ok: false, status: 403 });
    expect(mockDetermineRole).not.toHaveBeenCalled();
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

describe("requireRole — tenant resolution follows the host-switch (Batch D-b)", () => {
  it("scopes to the org getCurrentOrgId resolves (the host-switch), NOT the raw session.orgId", async () => {
    // Session says org A, but the Host names org B and the user is a member of
    // B, so the data layer's getCurrentOrgId resolves to B. Authorization must
    // follow: the caller is scoped to B, and their invite/approve/revoke land in
    // B — the org they are viewing — not their session org A. (Against the old
    // "trust session.orgId" code this returned org A — the divergence this fix
    // closes.)
    mockAuth.mockResolvedValue(session({ orgId: "org-a" }));
    mockGetCurrentOrgId.mockResolvedValue("org-b");
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(membership("admin"));

    await expect(requireRole("admin")).resolves.toEqual({
      ok: true,
      userId: "u1",
      orgId: "org-b",
      role: "admin",
    });
    expect(mockGetMembership).toHaveBeenCalledWith("u1", "org-b");
  });

  it("re-checks membership in whatever org getCurrentOrgId returns, and denies a non-member of it (defence-in-depth)", async () => {
    // DEFENCE-IN-DEPTH test, NOT the resolver's real behaviour. The real
    // getCurrentOrgId (lib/tenant.resolveTenantOrgId) NEVER returns a host org
    // the caller isn't a member of — for a non-member of the host it returns the
    // caller's own SESSION org (proved in lib/tenant.test.ts's "keeps the SESSION
    // org when the user is NOT a member of the host org", ~line 223, and end-to-
    // end through requireRole in lib/authz-tenant-integration.test.ts). So the
    // resolver handing back "org-b" for a non-member of org-b is a state that
    // resolver can't actually produce; we force it here only to prove requireRole
    // independently re-confirms membership in whatever org it is handed and
    // denies when there is none — it does NOT trust the resolver blindly, and it
    // does NOT silently re-scope to the session org to let the action through.
    mockAuth.mockResolvedValue(session({ orgId: "org-a" }));
    mockGetCurrentOrgId.mockResolvedValue("org-b");
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(null);
    mockGetOrgById.mockResolvedValue({
      id: "org-b",
      name: "Org B",
      verifiedDomain: "org-b.example", // alice@sanjow.com does NOT match
      createdAt: new Date().toISOString(),
    });

    await expect(requireRole("viewer")).resolves.toMatchObject({ ok: false, status: 403 });
    expect(mockGetMembership).toHaveBeenCalledWith("u1", "org-b");
    expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
  });
});

describe("requireRole — local dev WASABI_DEV_NO_AUTH bypass", () => {
  // The bypass only ever runs in local dev — middleware.ts refuses to boot with
  // the flag set under VERCEL/production — so pin VERCEL empty here to keep the
  // guard's env checks deterministic regardless of where the suite runs. (NODE_ENV
  // is already "test" under vitest, so the "not production" half holds.)
  beforeEach(() => {
    vi.stubEnv("WASABI_DEV_NO_AUTH", "1");
    vi.stubEnv("VERCEL", "");
  });

  it("no session → a synthetic owner grant (the god-mode default), never a DB lookup", async () => {
    mockAuth.mockResolvedValue(null);

    await expect(requireRole("owner")).resolves.toEqual({
      ok: true,
      userId: DEV_NO_AUTH_USER_ID,
      orgId: "sanjow",
      role: "owner",
    });
    // No real session means nothing to attribute to — it must not touch the DB.
    expect(mockFindUserByEmail).not.toHaveBeenCalled();
  });

  it("a REAL local session is preferred over the sentinel — attributes to the real user.id", async () => {
    // A developer who registered + bootstrapped a real account locally (owner of
    // their fresh org) keeps the flag on. requireRole must return their real id,
    // not DEV_NO_AUTH_USER_ID — otherwise a write to a user(id) foreign key crashes.
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(membership("owner"));

    await expect(requireRole("admin")).resolves.toEqual({
      ok: true,
      userId: "u1",
      orgId: ORG,
      role: "owner",
    });
    expect(mockFindUserByEmail).toHaveBeenCalledWith(EMAIL);
  });

  it("with a real session, authorization is the caller's REAL role — the flag is not blanket owner", async () => {
    // Falling through means a real viewer session stays a viewer, not an owner:
    // the bypass grants owner only when there is no session to derive a role from.
    mockAuth.mockResolvedValue(session());
    mockFindUserByEmail.mockResolvedValue(user());
    mockGetMembership.mockResolvedValue(membership("viewer"));

    await expect(requireRole("admin")).resolves.toMatchObject({ ok: false, status: 403 });
  });
});
