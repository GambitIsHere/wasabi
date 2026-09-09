// ============================================================================
// /admin/members — member onboarding: invite people, approve pending
// self-registrations, and see/revoke pending invites. Extends the previous
// pending-approval-only page with the invite surface (InviteMemberForm +
// PendingInvitesTable). Changing an existing member's role and removing a
// member live in /settings (app/settings/page.tsx, with lib/member-permissions'
// full privilege model) — this page is deliberately the onboarding half, not a
// second member directory.
// ----------------------------------------------------------------------------
// Auth-gated the same way it always was: middleware.ts proves "signed in", this
// page's own roleAtLeast(session.role, "admin") check decides "may see member
// management" — kept as a plain session-JWT read (not lib/authz.ts's
// requireRole(), which re-derives from the DB) because this is a RENDERING
// decision, not a mutation; every actual mutation lives in
// app/admin/members/actions.ts, which DOES call requireRole() on every call
// (re-derived from the database, live — see that file's header). A demoted
// admin therefore still sees this page until their JWT refreshes (same
// documented trade-off as every other session-role read in this codebase —
// auth.config.ts's jwt callback header comment), but can perform exactly
// nothing once here, because the actions re-check independently.
// ============================================================================
import { auth } from "@/auth";
import { ApproveMemberButton } from "@/components/admin/ApproveMemberButton";
import { InviteMemberForm } from "@/components/admin/InviteMemberForm";
import { PendingInvitesTable, type PendingInviteRow } from "@/components/admin/PendingInvitesTable";
import { listPendingInvitations } from "@/lib/invitations";
import { listPendingMembersForOrg } from "@/lib/membership";
import { roleAtLeast } from "@/lib/roles";
import { getUserById } from "@/lib/users";

export const dynamic = "force-dynamic";

export default async function MembersAdminPage() {
  const session = await auth();
  const canManage = Boolean(session?.role && roleAtLeast(session.role, "admin"));

  if (!session?.orgId || !canManage) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-bad/30 bg-bad/5 px-5 py-6 text-sm text-bad"
      >
        Only an org owner or admin can manage members.
      </div>
    );
  }

  const orgId = session.orgId;

  const [pendingMembers, invitations] = await Promise.all([
    listPendingMembersForOrg(orgId),
    listPendingInvitations(orgId),
  ]);

  // Resolve each invite's inviter id -> email for display. Invitation only
  // stores invited_by as a user id (lib/invitations.ts's Invitation type) —
  // small N (one org's pending invites), so a plain Promise.all here is simpler
  // than adding a join to lib/invitations.ts.
  const inviteRows: PendingInviteRow[] = await Promise.all(
    invitations.map(async (inv) => {
      const inviter = inv.invitedBy ? await getUserById(inv.invitedBy) : null;
      return {
        id: inv.id,
        email: inv.email,
        role: inv.role,
        invitedByEmail: inviter?.email ?? null,
        expiresAt: inv.expiresAt,
        tokenPrefix: inv.tokenPrefix,
      };
    }),
  );

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <p className="eyebrow">Admin · members</p>
        <h1 className="font-display text-3xl font-bold tracking-tight text-fg">
          Manage <span className="serif-accent">members</span>
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          Invite people to this organization and approve self-registered accounts. Without a
          configured email sender (see{" "}
          <code className="font-mono text-xs text-accent/90">.env.example</code>), invite links are
          handed to you directly to copy and send, and approval is the only way a
          password-registered account becomes active. Change roles and remove access from{" "}
          <span className="font-mono text-xs text-accent/90">Settings</span>.
        </p>
      </section>

      <InviteMemberForm />

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold text-fg">Pending approvals</h2>
        {pendingMembers.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line-strong bg-surface px-5 py-10 text-center text-sm text-muted">
            No pending members.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {pendingMembers.map((member) => (
              <li key={member.userId} className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fg">
                    {member.name ? `${member.name} · ` : ""}
                    {member.email}
                  </p>
                  <p className="font-mono text-[11px] text-faint">
                    Registered {new Date(member.registeredAt).toLocaleDateString()} · will become{" "}
                    {member.role}
                  </p>
                </div>
                <ApproveMemberButton userId={member.userId} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold text-fg">Pending invites</h2>
        <PendingInvitesTable invites={inviteRows} />
      </section>
    </div>
  );
}
