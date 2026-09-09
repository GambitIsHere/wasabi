// ============================================================================
// auth.config.test.ts — #33 (security): the Google OAuth signIn callback must
// gate provisioning on a REAL per-org verified_domain, never the global
// AUTH_ALLOWED_EMAIL_DOMAIN env. This is the twin of #28 (closed on the
// lazy-provisioning path in lib/authz.ts by PR #31); the same owner-claim
// vector lived on the sign-in path here. DB-touching deps are mocked (this
// codebase's DB-free unit-test convention — same vi.mock pattern as
// authz.test.ts / credentials-auth.test.ts); lib/domain-restriction stays real
// (pure), so the email-vs-domain match is exercised for real.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/org", () => ({ resolveOrgFromRequestHeader: vi.fn() }));
vi.mock("@/lib/users", () => ({
  findUserByEmail: vi.fn(),
  createUser: vi.fn(),
  // Pure in the real module (just lowercases/trims) — keep a faithful stand-in
  // so the callback's normalizedEmail path behaves as it does in prod.
  normalizeEmail: (raw: string) => raw.trim().toLowerCase(),
}));
vi.mock("@/lib/membership", () => ({
  determineRoleForNewMembership: vi.fn(),
  findOrCreateMembership: vi.fn(),
}));

import { authConfig } from "@/auth.config";
import { resolveOrgFromRequestHeader } from "@/lib/org";
import { createUser, findUserByEmail } from "@/lib/users";
import { determineRoleForNewMembership, findOrCreateMembership } from "@/lib/membership";
import type { Organization } from "@/lib/org";
import type { User } from "@/lib/users";
import type { Membership } from "@/lib/membership";
import type { MembershipRole } from "@/lib/roles";

const mockResolveOrg = vi.mocked(resolveOrgFromRequestHeader);
const mockFindUserByEmail = vi.mocked(findUserByEmail);
const mockCreateUser = vi.mocked(createUser);
const mockDetermineRole = vi.mocked(determineRoleForNewMembership);
const mockFindOrCreateMembership = vi.mocked(findOrCreateMembership);

// The signIn callback mutates `user` in place (user.id/orgId/role) — mirror its
// runtime shape without dragging in the full next-auth User/Account types.
type SignInUser = {
  email?: string | null;
  name?: string | null;
  image?: string | null;
  id?: string;
  orgId?: string;
  role?: MembershipRole;
};
type SignInCallback = (params: {
  user: SignInUser;
  account: { provider: string } | null;
}) => Promise<boolean>;

const signIn = authConfig.callbacks!.signIn! as unknown as SignInCallback;

const ORG = "sanjow";
const DOMAIN = "sanjow.com";
const EMAIL = "alice@sanjow.com";

function org(overrides: Partial<Organization> = {}): Organization {
  return {
    id: ORG,
    name: "Sanjow",
    verifiedDomain: DOMAIN,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
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

function googleSignIn(email: string | null = EMAIL, overrides: Partial<SignInUser> = {}): SignInUser {
  return { email, name: "Alice", image: null, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signIn (Google) — verified_domain is the only provisioning gate (#33)", () => {
  it("#33 owner-claim: a domain-less org with AUTH_ALLOWED_EMAIL_DOMAIN still set denies Google provisioning — no owner bootstrap", async () => {
    // The vector: a domain-LESS org (verified_domain NULL) while the global env
    // domain is still set in prod. Under the old `?? process.env.
    // AUTH_ALLOWED_EMAIL_DOMAIN` fallback, alice@sanjow.com matched the env
    // "sanjow.com" and — as the first active member — was bootstrapped to OWNER
    // of an org she never belonged to. With the env fallback gone, a null
    // verified_domain provisions nobody: no user row, no membership, no
    // owner-bootstrap, denied. Twin of the #28 authz.test.ts case.
    vi.stubEnv("AUTH_ALLOWED_EMAIL_DOMAIN", DOMAIN);
    mockResolveOrg.mockResolvedValue(org({ name: "Domainless Org", verifiedDomain: null }));

    await expect(signIn({ user: googleSignIn(), account: { provider: "google" } })).resolves.toBe(false);
    expect(mockDetermineRole).not.toHaveBeenCalled();
    expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
    // Rejected before it ever touched the user table.
    expect(mockFindUserByEmail).not.toHaveBeenCalled();
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it("an org WITH a matching verified_domain still signs in and provisions (bootstrapping owner) — no regression", async () => {
    // No env stubbed on purpose: prove provisioning works off the org's own
    // verified_domain alone, not the global env.
    mockResolveOrg.mockResolvedValue(org({ verifiedDomain: DOMAIN }));
    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(user());
    mockDetermineRole.mockResolvedValue("owner"); // first active member of the org
    mockFindOrCreateMembership.mockResolvedValue(membership("owner"));

    const u = googleSignIn();
    await expect(signIn({ user: u, account: { provider: "google" } })).resolves.toBe(true);
    expect(mockDetermineRole).toHaveBeenCalledWith(ORG, true);
    expect(mockFindOrCreateMembership).toHaveBeenCalledWith("u1", ORG, "owner");
    // The callback bakes our ids onto `user` in place for the jwt callback.
    expect(u).toMatchObject({ id: "u1", orgId: ORG, role: "owner" });
  });

  it("a matching verified_domain but an off-domain email still denies (domain gate intact)", async () => {
    mockResolveOrg.mockResolvedValue(org({ verifiedDomain: DOMAIN }));

    await expect(
      signIn({ user: googleSignIn("mallory@evil.com"), account: { provider: "google" } }),
    ).resolves.toBe(false);
    expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
  });

  it("an existing non-active (pending) account is refused even on a matching domain (active-only rule stays)", async () => {
    mockResolveOrg.mockResolvedValue(org({ verifiedDomain: DOMAIN }));
    mockFindUserByEmail.mockResolvedValue(user({ id: "u2", email: "bob@sanjow.com", status: "pending" }));

    await expect(
      signIn({ user: googleSignIn("bob@sanjow.com"), account: { provider: "google" } }),
    ).resolves.toBe(false);
    expect(mockDetermineRole).not.toHaveBeenCalled();
    expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
  });

  it("a non-Google (Credentials) sign-in is a passthrough — returns true without resolving an org", async () => {
    await expect(
      signIn({ user: googleSignIn("someone@whatever.com"), account: { provider: "credentials" } }),
    ).resolves.toBe(true);
    expect(mockResolveOrg).not.toHaveBeenCalled();
  });

  it("an unresolvable org denies (never guesses which org the sign-in is for)", async () => {
    vi.stubEnv("AUTH_ALLOWED_EMAIL_DOMAIN", DOMAIN);
    mockResolveOrg.mockResolvedValue(null);

    await expect(signIn({ user: googleSignIn(), account: { provider: "google" } })).resolves.toBe(false);
    expect(mockFindOrCreateMembership).not.toHaveBeenCalled();
  });
});
