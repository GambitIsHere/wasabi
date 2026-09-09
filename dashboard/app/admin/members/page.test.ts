// ============================================================================
// #29: /admin/members must gate + scope through lib/authz.requireRole("admin"),
// NOT a raw session.role/session.orgId read. Two properties pinned here:
//   - it lists pending members/invites by the org requireRole RESOLVED
//     (auth.orgId — host-switch-aware), so an admin on org B's host sees org B's
//     pending members, not their session org A's;
//   - a failed gate renders the denial panel and fetches nothing.
// The page is a server component; we call it as the plain async function it is
// and inspect its mock calls / returned element — no DOM render needed (the
// child components are stubbed so importing the page pulls no client code).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/membership", () => ({ listPendingMembersForOrg: vi.fn() }));
vi.mock("@/lib/invitations", () => ({ listPendingInvitations: vi.fn() }));
vi.mock("@/lib/users", () => ({ getUserById: vi.fn() }));
vi.mock("@/components/admin/ApproveMemberButton", () => ({ ApproveMemberButton: () => null }));
vi.mock("@/components/admin/InviteMemberForm", () => ({ InviteMemberForm: () => null }));
vi.mock("@/components/admin/PendingInvitesTable", () => ({ PendingInvitesTable: () => null }));

import { requireRole } from "@/lib/authz";
import { listPendingMembersForOrg } from "@/lib/membership";
import { listPendingInvitations } from "@/lib/invitations";
import MembersAdminPage from "@/app/admin/members/page";

const mockRequireRole = vi.mocked(requireRole);
const mockListPendingMembers = vi.mocked(listPendingMembersForOrg);
const mockListPendingInvitations = vi.mocked(listPendingInvitations);

beforeEach(() => {
  vi.clearAllMocks();
  mockListPendingMembers.mockResolvedValue([]);
  mockListPendingInvitations.mockResolvedValue([]);
});

describe("/admin/members page — #29 requireRole gating + host-scoped listing", () => {
  it("lists pending members by the requireRole-resolved org, not the session org", async () => {
    // Session might be org-a, but requireRole resolved org-b (host-switch). The
    // list MUST follow the resolved org.
    mockRequireRole.mockResolvedValue({
      ok: true,
      userId: "u1",
      orgId: "org-b",
      role: "admin",
    });

    await MembersAdminPage();

    expect(mockRequireRole).toHaveBeenCalledWith("admin");
    expect(mockListPendingMembers).toHaveBeenCalledWith("org-b");
    expect(mockListPendingInvitations).toHaveBeenCalledWith("org-b");
  });

  it("renders the denial panel and fetches nothing when the gate fails", async () => {
    mockRequireRole.mockResolvedValue({
      ok: false,
      status: 403,
      error: "You don't have permission to perform this action.",
    });

    const result = (await MembersAdminPage()) as { props?: { role?: string } };

    expect(result.props?.role).toBe("alert");
    expect(mockListPendingMembers).not.toHaveBeenCalled();
    expect(mockListPendingInvitations).not.toHaveBeenCalled();
  });
});
