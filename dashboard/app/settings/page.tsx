// ============================================================================
// /settings — org profile + member management (org owner/admin only).
// ----------------------------------------------------------------------------
// Gated by lib/authz.requireRole("admin"): a viewer/editor (or an
// unauthenticated request that slips the middleware gate) never sees the org's
// member list — the page renders a denial panel and fetches nothing. The nav
// entry (components/SiteNav.tsx) is hidden for non-admins too, but that is only
// UX; THIS gate and the per-action gates in app/settings/actions.ts are the
// boundary. Per-row `canManage` / `assignableRoles` computed here decide what
// controls to render; the server actions re-derive and re-enforce the identical
// privilege model, so a hand-crafted request can't do more than the UI shows.
// ============================================================================
import { requireRole } from "@/lib/authz";
import { assignableRolesFor, canManageMember, roleRank } from "@/lib/member-permissions";
import { listMembersForOrg } from "@/lib/membership";
import { getOrgById } from "@/lib/org";
import { getUserById } from "@/lib/users";
import { MemberRow } from "@/components/settings/MemberRow";

export const dynamic = "force-dynamic";

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default async function SettingsPage() {
  const auth = await requireRole("admin");

  if (!auth.ok) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-bad/30 bg-bad/5 px-5 py-6 text-sm text-bad"
      >
        Only an org owner or admin can open Settings.
      </div>
    );
  }

  const [org, me, members] = await Promise.all([
    getOrgById(auth.orgId),
    getUserById(auth.userId),
    listMembersForOrg(auth.orgId),
  ]);

  const viewerRole = auth.role;
  const sorted = [...members].sort((a, b) => {
    const ap = a.status === "pending" ? 0 : 1;
    const bp = b.status === "pending" ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const byRank = roleRank(b.role) - roleRank(a.role);
    if (byRank !== 0) return byRank;
    return (a.name || a.email).localeCompare(b.name || b.email);
  });
  const pendingCount = members.filter((m) => m.status === "pending").length;

  const meInitial = (me?.name?.trim()?.[0] ?? me?.email?.[0] ?? "?").toUpperCase();

  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <p className="eyebrow">Settings</p>
        <h1 className="font-display text-3xl font-bold tracking-tight text-fg">
          Profile &amp; <span className="serif-accent">members</span>
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          Manage who can reach Optimiser.Pro for {org?.name ?? "your organization"} — approve
          new sign-ups, set roles, and remove access.
        </p>
      </section>

      {/* Profile + org — two cards side by side on wide screens. */}
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface p-5">
          <p className="eyebrow mb-3">Your profile</p>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-bg font-mono text-sm text-muted">
              {me?.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={me.image} alt="" className="h-full w-full object-cover" />
              ) : (
                meInitial
              )}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-fg">{me?.name || me?.email || "—"}</p>
              {me?.email && (
                <p className="truncate font-mono text-[11px] text-faint">{me.email}</p>
              )}
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-faint">Role</dt>
            <dd className="font-mono text-fg">{titleCase(viewerRole)}</dd>
          </dl>
        </div>

        <div className="rounded-xl border border-line bg-surface p-5">
          <p className="eyebrow mb-3">Organization</p>
          <p className="text-sm font-medium text-fg">{org?.name ?? auth.orgId}</p>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-faint">Workspace</dt>
            <dd className="font-mono text-muted">{auth.orgId}</dd>
            <dt className="text-faint">Verified domain</dt>
            <dd className="font-mono text-muted">{org?.verifiedDomain ?? "—"}</dd>
          </dl>
        </div>
      </section>

      {/* Member directory. */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-xl font-semibold tracking-tight text-fg">Members</h2>
          <p className="font-mono text-[11px] text-faint">
            {members.length} member{members.length === 1 ? "" : "s"}
            {pendingCount > 0 ? ` · ${pendingCount} pending` : ""}
          </p>
        </div>

        {members.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line-strong bg-surface px-5 py-10 text-center text-sm text-muted">
            No members yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[560px] border-collapse text-left">
              <thead>
                <tr className="text-faint">
                  <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide">
                    Member
                  </th>
                  <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide">
                    Role
                  </th>
                  <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide">
                    Status
                  </th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium uppercase tracking-wide">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((m) => (
                  <MemberRow
                    key={m.userId}
                    userId={m.userId}
                    email={m.email}
                    name={m.name}
                    image={m.image}
                    role={m.role}
                    status={m.status}
                    isSelf={m.userId === auth.userId}
                    canManage={canManageMember(viewerRole, m.role)}
                    assignableRoles={assignableRolesFor(viewerRole, m.role)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
