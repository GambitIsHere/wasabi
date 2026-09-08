// ============================================================================
// /operator/orgs/[orgId] — one organization's drill-in (the detail view behind
// the operator console's Orgs tab).
// ----------------------------------------------------------------------------
// RE-GATES with requireSuperAdmin() independently — never trusting that the
// parent /operator page already did. The gate runs before getOrgDetail, so a
// refused caller reads no cross-org data even by deep-linking straight here.
// ============================================================================
import type { Metadata } from "next";
import Link from "next/link";
import { AccessDenied } from "@/components/operator/AccessDenied";
import { ExperimentsPanel } from "@/components/operator/ExperimentsPanel";
import { MembersPanel } from "@/components/operator/MembersPanel";
import { getOrgDetail } from "@/lib/platform";
import { requireSuperAdmin } from "@/lib/superadmin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Organization — Operator console",
  robots: { index: false, follow: false },
};

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <p className="eyebrow">{label}</p>
      <p className="mt-2 font-display text-3xl font-bold tabular-nums text-fg">
        {value.toLocaleString()}
      </p>
    </div>
  );
}

export default async function OrgDetailPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) {
    return <AccessDenied message={gate.error} />;
  }

  const { orgId } = await params;
  const detail = await getOrgDetail(orgId);

  if (!detail) {
    return (
      <div className="space-y-6">
        <Link
          href="/operator#orgs"
          className="font-mono text-xs text-faint transition-colors hover:text-accent"
        >
          ← All organizations
        </Link>
        <div
          role="alert"
          className="rounded-xl border border-line-strong bg-surface px-5 py-10 text-center text-sm text-muted"
        >
          No organization found for <span className="font-mono text-fg">{orgId}</span>.
        </div>
      </div>
    );
  }

  const { org, projects, members, experiments, counts } = detail;

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href="/operator#orgs"
          className="font-mono text-xs text-faint transition-colors hover:text-accent"
        >
          ← All organizations
        </Link>
        <section className="space-y-2">
          <p className="eyebrow">Organization</p>
          <h1 className="font-display text-3xl font-bold tracking-tight text-fg">{org.name}</h1>
          <p className="font-mono text-[11px] text-faint">
            {org.id}
            {org.verifiedDomain ? ` · ${org.verifiedDomain}` : " · no domain"} · created{" "}
            {new Date(org.createdAt).toLocaleDateString()}
          </p>
        </section>
      </div>

      <section aria-label="Organization KPIs" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Members" value={counts.members} />
        <StatCard label="Projects" value={counts.projects} />
        <StatCard label="Live tests" value={counts.liveExperiments} />
        <StatCard label="Archived tests" value={counts.archivedExperiments} />
      </section>

      {projects.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold text-fg">Projects</h2>
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {projects.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-4 px-5 py-3.5">
                <span className="text-sm text-fg">{p.name}</span>
                <span className="font-mono text-[11px] text-faint">
                  {p.id} · {new Date(p.createdAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold text-fg">Members</h2>
        <MembersPanel members={members} />
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold text-fg">Experiments</h2>
        <ExperimentsPanel experiments={experiments} />
      </section>
    </div>
  );
}
