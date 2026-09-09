// ============================================================================
// /api/register — guard test for Task C.
// ----------------------------------------------------------------------------
// Task C adds a SECOND door into an org (app/accept-invite/actions.ts's
// acceptInviteAsNewUser) that deliberately bypasses the registration domain
// restriction AND creates an ACTIVE account. This test pins the invariant that
// the FIRST door — self-registration here — is UNCHANGED by that: it still
// enforces the org's verified domain, and still creates only "pending"
// accounts. If a future edit ever weakened either property, this fails.
//
// Only the DB/IO-touching dependencies are mocked (this codebase's convention).
// @/lib/domain-restriction is left REAL on purpose — the domain check is the
// exact thing under test, so it must be the real suffix-match, not a stub.
// normalizeEmail / validatePasswordStrength are likewise left real.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rate-limit", () => ({
  takeToken: vi.fn(() => true),
  perMinute: (n: number) => n,
}));
vi.mock("@/lib/get-client-ip", () => ({ getClientIp: vi.fn(() => "203.0.113.7") }));
vi.mock("@/lib/org", () => ({ resolveOrgFromRequestHeader: vi.fn() }));
vi.mock("@/lib/email-verification", () => ({ sendVerificationEmail: vi.fn(async () => false) }));
vi.mock("@/lib/membership", () => ({
  determineRoleForNewMembership: vi.fn(async () => "viewer"),
  findOrCreateMembership: vi.fn(async () => ({})),
}));
vi.mock("@/lib/users", async () => {
  const actual = await vi.importActual<typeof import("@/lib/users")>("@/lib/users");
  return { ...actual, findUserByEmail: vi.fn(async () => null), createUser: vi.fn() };
});
vi.mock("@/lib/password", async () => {
  const policy = await vi.importActual<typeof import("@/lib/password-policy")>("@/lib/password-policy");
  return { ...policy, hashPassword: vi.fn(async () => "argon2-hash-stub") };
});

import { POST } from "@/app/api/register/route";
import { resolveOrgFromRequestHeader } from "@/lib/org";
import { createUser, findUserByEmail } from "@/lib/users";
import type { Organization } from "@/lib/org";

const mockResolveOrg = vi.mocked(resolveOrgFromRequestHeader);
const mockCreateUser = vi.mocked(createUser);
const mockFindUserByEmail = vi.mocked(findUserByEmail);

const STRONG_PASSWORD = "Wasabi-Cockpit-77";

function org(overrides: Partial<Organization> = {}): Organization {
  return {
    id: "sanjow",
    name: "Sanjow",
    verifiedDomain: "sanjow.com",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function registerRequest(body: Record<string, unknown>): Request {
  return new Request("http://sanjow.localhost:3000/api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveOrg.mockResolvedValue(org());
  mockFindUserByEmail.mockResolvedValue(null);
  mockCreateUser.mockResolvedValue({
    id: "u1",
    email: "staff@sanjow.com",
    name: null,
    image: null,
    passwordHash: "argon2-hash-stub",
    emailVerifiedAt: null,
    status: "pending",
    createdAt: new Date().toISOString(),
  });
});

describe("/api/register is still DOMAIN-CHECKED (Task C's invite bypass didn't leak here)", () => {
  it("🔴 rejects an off-domain email — the exact address an invite would let in", async () => {
    const res = await POST(registerRequest({
      email: "consultant@totally-unrelated-domain.io",
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    }));

    expect(res.status).toBe(400);
    const data = (await res.json()) as { ok: boolean; error?: string };
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/restricted to @sanjow\.com/i);
    // The domain gate stops it before any account is created.
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it("still rejects registration when the org has no verified domain configured", async () => {
    mockResolveOrg.mockResolvedValue(org({ verifiedDomain: null }));

    const res = await POST(registerRequest({
      email: "staff@sanjow.com",
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    }));

    expect(res.status).toBe(400);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });
});

describe("/api/register still creates only PENDING accounts (never active)", () => {
  it("🔴 an on-domain registration creates a user with status 'pending'", async () => {
    const res = await POST(registerRequest({
      email: "staff@sanjow.com",
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    }));

    expect(res.status).toBe(201);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);

    expect(mockCreateUser).toHaveBeenCalledTimes(1);
    // The whole contrast with Task C's accept path: self-registration is
    // "pending" and waits for approval; accept-on-invite is "active".
    expect(mockCreateUser.mock.calls[0][0].status).toBe("pending");
  });
});
