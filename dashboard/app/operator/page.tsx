// ============================================================================
// /operator — the Sanjow super-admin operator console (cross-org backoffice).
// ----------------------------------------------------------------------------
// DISTINCT from /admin (which is the PER-ORG admin area — members/metrics/reseed
// for the caller's own org). This route is cross-tenant and is gated to Sanjow
// PLATFORM operators only, via requireSuperAdmin() (lib/superadmin.ts) — NOT the
// per-org requireRole(). The gate runs BEFORE any data is fetched: on refusal we
// render only AccessDenied and read nothing cross-org, so an unauthorized caller
// (including another org's owner) can never trigger a cross-tenant read.
//
// Middleware already guarantees a session before this page renders (the route is
// not in middleware.ts's PUBLIC_PREFIXES); requireSuperAdmin adds the platform
// authorization on top.
// ============================================================================
import type { Metadata } from "next";
import { AccessDenied } from "@/components/operator/AccessDenied";
import { OperatorConsole } from "@/components/operator/OperatorConsole";
import {
  getPlatformOverview,
  listOrgSummaries,
  listPlatformExperiments,
  listPlatformMembers,
} from "@/lib/platform";
import { requireSuperAdmin } from "@/lib/superadmin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Operator console — Wasabi",
  robots: { index: false, follow: false },
};

export default async function OperatorPage() {
  const gate = await requireSuperAdmin();
  if (!gate.ok) {
    return <AccessDenied message={gate.error} />;
  }

  // Authorized — safe to read across every tenant.
  const [overview, orgs, members, experiments] = await Promise.all([
    getPlatformOverview(),
    listOrgSummaries(),
    listPlatformMembers(),
    listPlatformExperiments(),
  ]);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <p className="eyebrow">Operator console · all organizations</p>
        <h1 className="font-display text-3xl font-bold tracking-tight text-fg">
          Sanjow <span className="serif-accent">platform</span> operations
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          Every organization, member and experiment across the Optimiser.Pro platform, in one
          place. This is a Sanjow-operator view — tenants never see each other here.
        </p>
      </section>

      <OperatorConsole
        overview={overview}
        orgs={orgs}
        members={members}
        experiments={experiments}
      />
    </div>
  );
}
