// ============================================================================
// /admin/members — pending-member approval (requirement 3(b)).
// ----------------------------------------------------------------------------
// Deliberately minimal: a list of pending self-registrations for the current
// org with an Approve button (components/admin/ApproveMemberButton.tsx,
// app/admin/members/actions.ts). Batch D-a's scope is the approval MECHANISM
// itself — a full member directory, role editing, and invites are Batch
// D-b's "invite/role UI" (see this batch's report). Auth-gated by
// middleware.ts like every other /admin page; the ROLE gate (owner/admin
// only) is enforced here and, redundantly, inside the server action itself
// (see that file's header comment on why both checks exist).
// ============================================================================
import { auth } from "@/auth";
import { ApproveMemberButton } from "@/components/admin/ApproveMemberButton";
import { listPendingMembersForOrg } from "@/lib/membership";
import { roleAtLeast } from "@/lib/roles";

export const dynamic = "force-dynamic";

export default async function MembersAdminPage() {
  const session = await auth();
  const canApprove = Boolean(session?.role && roleAtLeast(session.role, "admin"));

  if (!session?.orgId || !canApprove) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-bad/30 bg-bad/5 px-5 py-6 text-sm text-bad"
      >
        Only an org owner or admin can view pending members.
      </div>
    );
  }

  const pending = await listPendingMembersForOrg(session.orgId);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <p className="eyebrow">Admin</p>
        <h1 className="font-display text-3xl font-bold tracking-tight text-fg">
          Pending <span className="serif-accent">members</span>
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          Self-registered accounts waiting on approval. Without a configured email sender (see{" "}
          <code className="font-mono text-xs text-accent/90">.env.example</code>), this is the
          only way a password-registered account becomes active.
        </p>
      </section>

      {pending.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong bg-surface px-5 py-10 text-center text-sm text-muted">
          No pending members.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {pending.map((member) => (
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
    </div>
  );
}
