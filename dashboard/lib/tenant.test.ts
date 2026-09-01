// ============================================================================
// tenant.ts — behavioural tests for the tenant-context seam.
// ----------------------------------------------------------------------------
// Batch D-a made getCurrentTenant() resolve for real (see lib/tenant.ts's
// header comment on the resolution order: session first, subdomain fallback,
// throw rather than ever silently default to Sanjow). That means these tests
// now need to control what "the session" and "the subdomain" say — done by
// mocking the two modules lib/tenant.ts dynamically imports (@/auth and
// @/lib/org), NOT by hitting a real Next.js request or a real database. Three
// things pinned down:
//   1. the session fast path wins when present, and — critically — never
//      touches lib/org.ts at all (the whole point of putting orgId on the
//      session is skipping that DB round-trip; a test that only checked the
//      RETURN VALUE could pass even if that guarantee silently regressed),
//   2. the subdomain fallback + its own "org doesn't exist" → fail-closed
//      throw, never a silent Sanjow default, and
//   3. the id constants here are the EXACT ones scripts/migrate-tenancy.ts
//      backfills, unchanged from before this batch.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/org", () => ({
  resolveOrgFromRequestHeader: vi.fn(),
  getOrgById: vi.fn(),
  getFirstProjectIdForOrg: vi.fn(),
}));

import { auth } from "@/auth";
import { getFirstProjectIdForOrg, resolveOrgFromRequestHeader } from "@/lib/org";
import {
  SANJOW_DEFAULT_PROJECT_ID,
  SANJOW_DEFAULT_PROJECT_NAME,
  SANJOW_ORG_ID,
  SANJOW_ORG_NAME,
  SANJOW_ORG_VERIFIED_DOMAIN,
  getCurrentOrgId,
  getCurrentProjectId,
  getCurrentTenant,
  resolveTenantOrgId,
} from "@/lib/tenant";

// `auth`'s REAL type is an intersection of five call signatures (session
// getter, middleware wrapper, route-handler wrapper, …) — see next-auth's
// index.d.ts. vi.mocked() can't cleanly infer which overload to mock against
// an intersection type, so it picks the wrong one (a NextMiddleware wrapper)
// and `.mockResolvedValue()` stops type-checking correctly. Cast to the ONE
// signature this file actually exercises (the zero-arg session getter)
// before handing it to vi.mocked() — a type-level-only cast; at runtime
// `auth` is still exactly the same `vi.fn()` from the factory above.
type SessionGetter = () => Promise<Session | null>;
const mockAuth = vi.mocked(auth as unknown as SessionGetter);
const mockResolveOrgFromRequestHeader = vi.mocked(resolveOrgFromRequestHeader);
const mockGetFirstProjectIdForOrg = vi.mocked(getFirstProjectIdForOrg);

/** A minimally-valid Session for the mock — only `orgId` matters to
 *  lib/tenant.ts; `expires` is required by DefaultSession's shape. */
function sessionWithOrg(orgId: string | undefined): Session {
  return { expires: new Date(Date.now() + 60_000).toISOString(), orgId };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveTenantOrgId / getCurrentTenant — session fast path", () => {
  it("uses session.orgId and never calls lib/org.ts at all", async () => {
    mockAuth.mockResolvedValue(sessionWithOrg(SANJOW_ORG_ID));

    await expect(resolveTenantOrgId()).resolves.toEqual({
      orgId: SANJOW_ORG_ID,
      source: "session",
    });
    expect(mockResolveOrgFromRequestHeader).not.toHaveBeenCalled();
  });

  it("getCurrentTenant resolves Sanjow's project with zero I/O even via the session path", async () => {
    mockAuth.mockResolvedValue(sessionWithOrg(SANJOW_ORG_ID));

    await expect(getCurrentTenant()).resolves.toEqual({
      orgId: SANJOW_ORG_ID,
      projectId: SANJOW_DEFAULT_PROJECT_ID,
    });
    expect(mockGetFirstProjectIdForOrg).not.toHaveBeenCalled();
  });

  it("a session for a NON-Sanjow org looks up its project (no hardcoded shortcut for other tenants)", async () => {
    mockAuth.mockResolvedValue(sessionWithOrg("acme"));
    mockGetFirstProjectIdForOrg.mockResolvedValue("acme-default");

    await expect(getCurrentTenant()).resolves.toEqual({
      orgId: "acme",
      projectId: "acme-default",
    });
    expect(mockGetFirstProjectIdForOrg).toHaveBeenCalledWith("acme");
  });

  it("a session without orgId (pre-migration token) falls back to the subdomain, not silent Sanjow", async () => {
    mockAuth.mockResolvedValue(sessionWithOrg(undefined));
    mockResolveOrgFromRequestHeader.mockResolvedValue({
      id: SANJOW_ORG_ID,
      name: SANJOW_ORG_NAME,
      verifiedDomain: SANJOW_ORG_VERIFIED_DOMAIN,
      createdAt: new Date().toISOString(),
    });

    await expect(resolveTenantOrgId()).resolves.toEqual({
      orgId: SANJOW_ORG_ID,
      source: "subdomain",
    });
    expect(mockResolveOrgFromRequestHeader).toHaveBeenCalledOnce();
  });
});

describe("resolveTenantOrgId / getCurrentTenant — unauthenticated subdomain fallback", () => {
  it("resolves via the subdomain when there is no session", async () => {
    mockAuth.mockResolvedValue(null);
    mockResolveOrgFromRequestHeader.mockResolvedValue({
      id: "acme",
      name: "Acme",
      verifiedDomain: "acme.com",
      createdAt: new Date().toISOString(),
    });

    await expect(resolveTenantOrgId()).resolves.toEqual({ orgId: "acme", source: "subdomain" });
  });

  it("returns null when the subdomain doesn't resolve to a real org either", async () => {
    mockAuth.mockResolvedValue(null);
    mockResolveOrgFromRequestHeader.mockResolvedValue(null);

    await expect(resolveTenantOrgId()).resolves.toBeNull();
  });

  it("getCurrentTenant FAILS CLOSED (throws) rather than defaulting to Sanjow when nothing resolves", async () => {
    mockAuth.mockResolvedValue(null);
    mockResolveOrgFromRequestHeader.mockResolvedValue(null);

    await expect(getCurrentTenant()).rejects.toThrow(/no session and no resolvable subdomain/);
  });
});

describe("getCurrentOrgId / getCurrentProjectId", () => {
  it("getCurrentOrgId matches getCurrentTenant().orgId", async () => {
    mockAuth.mockResolvedValue(sessionWithOrg(SANJOW_ORG_ID));
    await expect(getCurrentOrgId()).resolves.toBe(SANJOW_ORG_ID);
  });

  it("getCurrentProjectId matches getCurrentTenant().projectId", async () => {
    mockAuth.mockResolvedValue(sessionWithOrg(SANJOW_ORG_ID));
    await expect(getCurrentProjectId()).resolves.toBe(SANJOW_DEFAULT_PROJECT_ID);
  });

  // I11 — getCurrentOrgId must resolve the ORG only, without also resolving a
  // project. A project-less org (no provisioning yet) used to make it throw,
  // which /roadmap "handled" by falling back to Sanjow's hardcoded plan — a
  // cross-tenant leak. Now it resolves the org while getCurrentProjectId still
  // throws for the missing project.
  it("getCurrentOrgId resolves a project-less org WITHOUT throwing (org-only)", async () => {
    mockAuth.mockResolvedValue(sessionWithOrg("acme"));
    mockGetFirstProjectIdForOrg.mockResolvedValue(null); // org exists, no project yet

    await expect(getCurrentOrgId()).resolves.toBe("acme");
    expect(mockGetFirstProjectIdForOrg).not.toHaveBeenCalled(); // never even asked for a project
  });

  it("getCurrentProjectId STILL throws for that same project-less org (unchanged)", async () => {
    mockAuth.mockResolvedValue(sessionWithOrg("acme"));
    mockGetFirstProjectIdForOrg.mockResolvedValue(null);

    await expect(getCurrentProjectId()).rejects.toThrow(/has no project yet/);
  });
});

describe("tenant id constants", () => {
  // Slug-shaped: scripts/migrate-tenancy.ts interpolates these directly into
  // DDL text (quoted, but not parameterised — see that file's sqlStringLiteral
  // comment) and they're TEXT PRIMARY KEY / FOREIGN KEY values, so anything
  // that isn't a plain lowercase-and-hyphen slug is worth catching here rather
  // than in a live migration run. Also the value lib/subdomain.ts's
  // DEFAULT_LEGACY_ORG_SLUG duplicates as a literal — see that module's header.
  const SLUG_RE = /^[a-z][a-z0-9-]*$/;

  it("SANJOW_ORG_ID is a plain slug", () => {
    expect(SANJOW_ORG_ID).toMatch(SLUG_RE);
  });

  it("SANJOW_DEFAULT_PROJECT_ID is a plain slug", () => {
    expect(SANJOW_DEFAULT_PROJECT_ID).toMatch(SLUG_RE);
  });

  it("org name and verified domain are non-empty (migrate-tenancy backfills them verbatim)", () => {
    expect(SANJOW_ORG_NAME.trim().length).toBeGreaterThan(0);
    expect(SANJOW_ORG_VERIFIED_DOMAIN).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
  });

  it("default project name is non-empty", () => {
    expect(SANJOW_DEFAULT_PROJECT_NAME.trim().length).toBeGreaterThan(0);
  });
});
