// ============================================================================
// "Unknown workspace" — rendered by app/layout.tsx INSTEAD OF `children` when
// lib/tenant.ts's resolveTenantOrgId() can't determine a tenant for this
// request (see that file's header comment on the resolution order).
// ----------------------------------------------------------------------------
// This is the guard requirement 1 asks for explicitly: "An unknown subdomain
// must not silently fall back to Sanjow — that would be a cross-tenant leak.
// Render a clear 'unknown workspace' page instead." Kept deliberately generic
// (no org names, no hint about which orgs DO exist) — this page is reachable
// by definition without a resolved tenant, so it must not leak anything about
// the multi-tenant structure itself.
// ============================================================================
export function UnknownWorkspace() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-surface px-6 py-16 text-center">
      <div className="mb-3 text-3xl" aria-hidden="true">
        🌶
      </div>
      <h1 className="font-display text-lg font-semibold text-fg">
        Unknown workspace
      </h1>
      <p className="mt-1.5 max-w-sm text-sm text-muted">
        This address doesn&apos;t match a workspace on Optimiser.Pro. Check the
        link, or go to your workspace&apos;s own address — e.g.{" "}
        <code className="font-mono text-xs text-accent/90">
          your-team.optimiser.pro
        </code>
        .
      </p>
    </div>
  );
}
