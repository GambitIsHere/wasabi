// ============================================================================
// Wasabi — the tenant-context seam (server-only).
// ----------------------------------------------------------------------------
// Wasabi is becoming multi-tenant (Optimiser.Pro): many orgs, each with one or
// more projects, each project owning its own experiments/metrics/events.
// getCurrentTenant() below is the ONE place every data module (lib/store.ts,
// lib/archive.ts, lib/events.ts, lib/roadmap-store.ts, lib/metrics.ts,
// lib/admin-reseed.ts) reads the current org/project from — none of them
// hardcode an id themselves. Batch D-a made this resolve for REAL (session
// org, or subdomain for an unauthenticated request) instead of a hardcoded
// Sanjow constant; every caller already awaited a TenantContext and filtered
// by it, so that change was exactly the one-file diff this seam was built for.
//
// RESOLUTION ORDER (requirement 5):
//   1. The authenticated session's org (session.orgId, set by auth.ts's jwt
//      callback at sign-in). Trusted at face value — no DB round-trip, which
//      is the whole point of putting orgId on the session (see auth.ts's
//      header comment on why re-validating it on every render would defeat
//      that). Wins regardless of which host the request came in on.
//   2. Otherwise, the subdomain — lib/subdomain.ts's pure host-parsing +
//      lib/org.ts's DB-backed existence check (via the ORG_SLUG_HEADER
//      middleware.ts set). This is the path an unauthenticated request takes
//      (chiefly /signin and /register — see app/layout.tsx, which gates
//      EVERY page on this same resolution and renders "unknown workspace"
//      when it comes up empty, so by the time any page's own body runs,
//      resolution already succeeded).
//   3. Neither resolves → THROW. Never silently default to Sanjow — that's
//      exactly the cross-tenant leak this batch's header comment (and
//      app/layout.tsx) warns about. In practice this should be unreachable
//      for any request that made it past app/layout.tsx's gate; the throw is
//      belt-and-braces for a caller that skips that gate somehow (mirrors
//      auth.ts's own "fail closed, belt-and-braces" philosophy).
//
// DYNAMIC IMPORTS, DELIBERATELY: resolveTenantOrgId() below imports "@/auth"
// and "./org" via `await import(...)` inside the function body, NOT as
// top-level `import` statements. Both transitively reach Next.js-specific
// subpaths (next/server, next/headers) that only resolve under Next's own
// bundler — NOT under the plain `node --experimental-strip-types` loader
// scripts/migrate-tenancy.ts runs under (confirmed: a static top-level import
// of "next-auth" alone throws ERR_MODULE_NOT_FOUND there). That script
// statically imports this file for its SANJOW_* constants only, never calls
// the resolution functions — so as long as this file's OWN top-level imports
// stay Next-free, the script keeps working unmodified. A static import here
// would silently break `npm run migrate:tenancy` the next time it's run.
//
// PER-TABLE SCOPE — decided when the tenancy columns were added
// (scripts/migrate-tenancy.ts), documented once here rather than re-litigated
// per file:
//   - experiment, archived_experiment, event, metric  → project_id.
//     Each row is something a single customer's project owns (an experiment
//     lives on one site/brand; an event is traffic to one; a metric registry
//     entry is defined per project so two projects can track different
//     things). Sanjow will eventually get one project per business
//     (TU / AC / AS / PDF / …) — splitting today's single default project is
//     later work, not this batch.
//   - roadmap_test → org_id.
//     The test-planning roadmap is Sanjow-internal planning across every lane
//     (i.e. every future business/project) at once — it doesn't belong to any
//     one project, so it hangs off the org instead.
//   - variant, archived_variant → NOT denormalised.
//     Both are children addressed only through their parent's globally-unique
//     key (experiment.key / archived_experiment.key) — see lib/store.ts and
//     lib/archive.ts's header comments on those two tables. Adding org_id /
//     project_id to them would be redundant with no query that needs it today
//     (see lib/tenant-scoping.test.ts for the guard that keeps this honest).
//   - organization, project, api_key, user, membership → new tables, not
//     tenant-scoped themselves (they ARE the tenancy / identity).
//
// KNOWN LIMITATION (documented, not fixed, in this batch): experiment.key,
// archived_experiment.key, metric.key and roadmap_test.id all stay GLOBAL
// primary keys, not composite (project_id, key). Two tenants therefore can't
// reuse the same slug (e.g. two customers both naming a test "homepage-test"
// would collide on insert). Fine while there's one tenant; a real blocker once
// there's more than one. Widening these to composite keys is a bigger,
// separate migration (it touches the variant FK, /api/decide, /api/flags and
// lib/metabase.ts's theme-slug lookups) — flagged here, not attempted here.
//
// KNOWN LIMITATION #2 (Batch D-a): per-org PROJECT PROVISIONING doesn't
// exist. resolveProjectId() below resolves Sanjow's project with zero I/O
// (the known SANJOW_DEFAULT_PROJECT_ID constant) and, for any OTHER org,
// reads whatever project row already exists (lib/org.ts's
// getFirstProjectIdForOrg) — but nothing CREATES that row for a brand-new
// org. Batch D-a's only real tenant is Sanjow, so this is unreachable today;
// it becomes real work the moment a second org signs up, which is explicitly
// Batch D-b+ scope (onboarding), not this batch's.
//
// NOT DONE (deliberately, follow-up batch): Postgres Row-Level Security.
// Enforcement here is entirely in the application layer (this file + the data
// modules' explicit WHERE/ownership checks), not the database. RLS would make
// a forgotten filter fail closed instead of open, which is strictly safer —
// but the Neon HTTP driver makes per-session `SET LOCAL app.tenant_id = …`
// unreliable outside an explicit transaction (each `sql\`…\`` call here is its
// own stateless HTTP request; there is no persistent session to SET on). RLS
// deserves its own focused batch that solves that properly, not a bolt-on.
// ============================================================================

/** A resolved tenant: the org (billing/identity boundary) and the project
 *  within it (the unit an experiment/event/metric belongs to). */
export interface TenantContext {
  orgId: string;
  projectId: string;
}

/** Sanjow's own org id — also the row id scripts/migrate-tenancy.ts creates,
 *  and the DEFAULT_LEGACY_ORG_SLUG value lib/subdomain.ts resolves to on
 *  every "no real subdomain to read" host. Duplicated as a literal there
 *  (not imported) so that module stays dependency-free and Edge-safe;
 *  lib/subdomain.test.ts pins the two against each other. */
export const SANJOW_ORG_ID = "sanjow";
export const SANJOW_ORG_NAME = "Sanjow Ventures";
export const SANJOW_ORG_VERIFIED_DOMAIN = "sanjow.com";

/** The single project every pre-existing row (experiment, event, metric, …)
 *  was backfilled into. See the header comment above for why this is a
 *  project-per-business placeholder, not the end state. */
export const SANJOW_DEFAULT_PROJECT_ID = "sanjow-default";
export const SANJOW_DEFAULT_PROJECT_NAME = "Sanjow (default)";

/** How resolveTenantOrgId() determined the org — "session" needed no DB
 *  round-trip (trusted the JWT claim); "subdomain" did (lib/org.ts validated
 *  the candidate slug against the organization table). Exposed so
 *  app/layout.tsx / auth-facing pages can tell the two apart if useful for
 *  messaging, without re-deriving it themselves. */
export type TenantResolutionSource = "session" | "subdomain";

export interface TenantResolution {
  orgId: string;
  source: TenantResolutionSource;
}

/**
 * Resolve which org THIS request belongs to — orgId only (no project; see
 * getCurrentTenant() for the full TenantContext). Returns null when neither
 * the session nor the subdomain resolves to anything, which is exactly the
 * signal app/layout.tsx uses to render "unknown workspace" instead of
 * `children` (see this file's header comment on the resolution order).
 *
 * Safe to call from an unauthenticated context (that's the primary reason it
 * exists as its own function rather than being inlined into
 * getCurrentTenant(): /signin and /register need "which org is this" WITHOUT
 * a session, to show the right branding/domain restriction before anyone has
 * signed in).
 */
export async function resolveTenantOrgId(): Promise<TenantResolution | null> {
  // Dynamic import — see this file's header comment ("DYNAMIC IMPORTS,
  // DELIBERATELY") for why this can't be a top-level `import`.
  const { auth } = await import("@/auth");
  const session = await auth();
  if (session?.orgId) {
    return { orgId: session.orgId, source: "session" };
  }

  const { resolveOrgFromRequestHeader } = await import("./org");
  const org = await resolveOrgFromRequestHeader();
  return org ? { orgId: org.id, source: "subdomain" } : null;
}

/**
 * For a page that needs the FULL org row (name, verifiedDomain) for display —
 * /signin ("Sign in to Sanjow"), /register ("restricted to @sanjow.com").
 * Assumes app/layout.tsx's gate already confirmed resolution succeeds for
 * this request (see resolveTenantOrgId's header comment) — throws in the
 * should-be-unreachable case it somehow didn't, rather than rendering a page
 * with no org context.
 */
export async function getResolvedOrgOrThrow(): Promise<{
  id: string;
  name: string;
  verifiedDomain: string | null;
}> {
  const resolution = await resolveTenantOrgId();
  if (!resolution) {
    throw new Error(
      "getResolvedOrgOrThrow: no tenant resolved. This should be unreachable — " +
        "app/layout.tsx's gate should already have rendered the unknown-workspace page " +
        "instead of this one.",
    );
  }
  const { getOrgById } = await import("./org");
  const org = await getOrgById(resolution.orgId);
  if (!org) {
    throw new Error(
      `getResolvedOrgOrThrow: resolved org "${resolution.orgId}" no longer exists in the database.`,
    );
  }
  return org;
}

/** See KNOWN LIMITATION #2 above. */
async function resolveProjectId(orgId: string): Promise<string> {
  if (orgId === SANJOW_ORG_ID) return SANJOW_DEFAULT_PROJECT_ID; // zero-I/O fast path
  const { getFirstProjectIdForOrg } = await import("./org");
  const projectId = await getFirstProjectIdForOrg(orgId);
  if (!projectId) {
    throw new Error(
      `getCurrentTenant: org "${orgId}" has no project yet — per-org project provisioning is ` +
        "out of scope for Batch D-a (see this file's KNOWN LIMITATION #2).",
    );
  }
  return projectId;
}

/**
 * Resolve the tenant for the current request. See this file's header comment
 * for the full resolution order and why it's safe to trust session.orgId
 * without re-reading the database on every render.
 */
export async function getCurrentTenant(): Promise<TenantContext> {
  const resolution = await resolveTenantOrgId();
  if (!resolution) {
    throw new Error(
      "getCurrentTenant: no session and no resolvable subdomain org — refusing to guess a " +
        "tenant (fails closed, never silently defaults to Sanjow). This should be unreachable " +
        "for a page render — app/layout.tsx's gate should have already stopped it; a Route " +
        "Handler or Server Action hitting this means it's reachable without a valid session AND " +
        "without a resolvable Host, which middleware.ts's auth gate should also prevent for any " +
        "non-public route.",
    );
  }
  const projectId = await resolveProjectId(resolution.orgId);
  return { orgId: resolution.orgId, projectId };
}

/** Convenience for org-scoped tables (roadmap_test). Resolves ONLY the org —
 *  deliberately NOT via getCurrentTenant(), which also resolves a project and
 *  throws for an org that has none yet (per-org project provisioning is out of
 *  scope — see KNOWN LIMITATION #2). An org-scoped caller (e.g. the roadmap
 *  store) must not inherit that project-resolution failure: it made /roadmap
 *  throw for a project-less tenant, which the page then "handled" by falling
 *  back to Sanjow's hardcoded roadmap — a cross-tenant leak. Failing closed
 *  (throw) only when NEITHER session nor subdomain resolves an org at all. */
export async function getCurrentOrgId(): Promise<string> {
  const resolution = await resolveTenantOrgId();
  if (!resolution) {
    throw new Error(
      "getCurrentOrgId: no session and no resolvable subdomain org — refusing to guess a " +
        "tenant (fails closed, never silently defaults to Sanjow).",
    );
  }
  return resolution.orgId;
}

/** Convenience for project-scoped tables (experiment, archived_experiment,
 *  event, metric). */
export async function getCurrentProjectId(): Promise<string> {
  return (await getCurrentTenant()).projectId;
}
