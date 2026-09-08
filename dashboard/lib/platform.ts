// ============================================================================
// lib/platform.ts — CROSS-ORG aggregation reads for the Sanjow operator console
// (server-only).
// ----------------------------------------------------------------------------
// Every read here is DELIBERATELY platform-wide (all tenants at once) — that is
// the whole point of the operator console. It is therefore the one module in
// the codebase that intentionally does NOT filter by a single tenant. The
// compensating control is at the call site: app/operator/* runs
// requireSuperAdmin() (lib/superadmin.ts) before ANY of these functions is
// called, and renders nothing but a refusal otherwise. Do not import these from
// a per-tenant page.
//
// TENANT-SCOPING GUARD (lib/tenant-scoping.test.ts): that guard requires every
// statement touching experiment/archived_experiment/event/metric to carry its
// project_id. Two shapes appear below:
//   • Per-org / per-experiment reads JOIN through `project`, so project_id is a
//     real, load-bearing part of the statement (attribution, not a tenant
//     filter) — the guard passes honestly.
//   • The handful of genuinely global COUNTs (platform overview) cannot carry a
//     per-tenant filter by definition; each is marked TENANT-SCOPE-EXEMPT with
//     this module's cross-org intent as the reason, exactly the escape hatch
//     lib/events.ts's pruneEvents uses for global retention.
//
// This module reuses lib/events.ts's startOfTodayIso() rather than re-deriving
// "today", and re-declares nothing the domain modules already own — it only
// aggregates across the tenant boundary they each stay inside.
// ============================================================================
import { createSchema, getSql } from "./db";
import { startOfTodayIso } from "./events";
import type {
  ArchivedStatus,
  OrgDetail,
  OrgSummary,
  PlatformExperiment,
  PlatformMember,
  PlatformOverview,
} from "./platform-types";
import { isMembershipRole, isUserStatus } from "./roles";

// Defence-in-depth: never ship the DB layer to the browser.
if (typeof window !== "undefined") {
  throw new Error("lib/platform.ts is server-only and must not run in the browser.");
}

// ---------------------------------------------------------------------------
// Row shapes (snake_case, as Neon returns them)
// ---------------------------------------------------------------------------

interface OrgSummaryRow {
  id: string;
  name: string;
  verified_domain: string | null;
  created_at: string;
  member_count: number;
  project_count: number;
  live_count: number;
  archived_count: number;
}

interface MemberRow {
  user_id: string;
  email: string;
  name: string | null;
  user_status: string;
  role: string;
  org_id: string;
  org_name: string;
  joined_at: string;
}

interface ExperimentRow {
  kind: string;
  key: string;
  name: string;
  business: string;
  goal_metric: string | null;
  active: number | null;
  archived_status: string | null;
  start_date: string | null;
  created_at: string | null;
  org_id: string;
  org_name: string;
}

interface StatusCountRow {
  status: string;
  n: number;
}

// ---------------------------------------------------------------------------
// Pure row → domain mappers + fold logic (no DB, no DOM) — unit-tested directly.
// ---------------------------------------------------------------------------

const ARCHIVED_STATUSES: readonly ArchivedStatus[] = [
  "winner",
  "inconclusive",
  "lost",
  "archived",
];

/** Coerce a stored archive status string to the union, or null. */
export function toArchivedStatus(value: string | null): ArchivedStatus | null {
  if (value === null) return null;
  return (ARCHIVED_STATUSES as readonly string[]).includes(value)
    ? (value as ArchivedStatus)
    : null;
}

export function toOrgSummary(row: OrgSummaryRow): OrgSummary {
  return {
    id: row.id,
    name: row.name,
    verifiedDomain: row.verified_domain,
    createdAt: row.created_at,
    memberCount: Number(row.member_count) || 0,
    projectCount: Number(row.project_count) || 0,
    liveExperimentCount: Number(row.live_count) || 0,
    archivedExperimentCount: Number(row.archived_count) || 0,
  };
}

export function toPlatformMember(row: MemberRow): PlatformMember {
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    // Fail to the least-privileged / safest value on an unrecognised string,
    // mirroring lib/users.ts and lib/membership.ts's own coercions.
    userStatus: isUserStatus(row.user_status) ? row.user_status : "suspended",
    role: isMembershipRole(row.role) ? row.role : "viewer",
    orgId: row.org_id,
    orgName: row.org_name,
    joinedAt: row.joined_at,
  };
}

export function toPlatformExperiment(row: ExperimentRow): PlatformExperiment {
  const kind = row.kind === "archived" ? "archived" : "live";
  return {
    kind,
    key: row.key,
    name: row.name,
    business: row.business,
    goalMetric: row.goal_metric,
    active: kind === "live" ? row.active === 1 : null,
    archivedStatus: kind === "archived" ? toArchivedStatus(row.archived_status) : null,
    startDate: row.start_date,
    createdAt: row.created_at,
    orgId: row.org_id,
    orgName: row.org_name,
  };
}

interface OverviewCounts {
  orgs: number;
  projects: number;
  members: number;
  liveExperiments: number;
  activeExperiments: number;
  archivedExperiments: number;
  events: number;
  eventsToday: number;
  userStatusRows: StatusCountRow[];
}

/** Fold the raw counts (+ the grouped user-status rows) into a PlatformOverview.
 *  Split out so the arithmetic is testable without a database. */
export function composeOverview(counts: OverviewCounts): PlatformOverview {
  let activeUsers = 0;
  let pendingUsers = 0;
  let suspendedUsers = 0;
  for (const row of counts.userStatusRows) {
    const n = Number(row.n) || 0;
    if (row.status === "active") activeUsers += n;
    else if (row.status === "pending") pendingUsers += n;
    else if (row.status === "suspended") suspendedUsers += n;
  }
  return {
    orgs: counts.orgs,
    projects: counts.projects,
    members: counts.members,
    activeUsers,
    pendingUsers,
    suspendedUsers,
    liveExperiments: counts.liveExperiments,
    activeExperiments: counts.activeExperiments,
    archivedExperiments: counts.archivedExperiments,
    events: counts.events,
    eventsToday: counts.eventsToday,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function scalar(rows: unknown): number {
  const first = (rows as { n?: number }[])[0];
  return Number(first?.n ?? 0) || 0;
}

/** Platform-wide headline counts for the Overview tab. */
export async function getPlatformOverview(): Promise<PlatformOverview> {
  await createSchema();
  const sql = getSql();
  const today = startOfTodayIso();

  const [
    orgsRows,
    projectsRows,
    membersRows,
    liveRows,
    activeRows,
    archivedRows,
    eventsRows,
    eventsTodayRows,
    userStatusRows,
  ] = await Promise.all([
    sql`SELECT COUNT(*)::int AS n FROM organization`,
    sql`SELECT COUNT(*)::int AS n FROM project`,
    sql`SELECT COUNT(*)::int AS n FROM membership`,
    // TENANT-SCOPE-EXEMPT: operator console — a platform-wide count of every
    // tenant's live experiments; gated by requireSuperAdmin at the call site.
    sql`SELECT COUNT(*)::int AS n FROM experiment`,
    // TENANT-SCOPE-EXEMPT: operator console — platform-wide running-experiment count.
    sql`SELECT COUNT(*)::int AS n FROM experiment WHERE active = 1`,
    // TENANT-SCOPE-EXEMPT: operator console — platform-wide archived-experiment count.
    sql`SELECT COUNT(*)::int AS n FROM archived_experiment`,
    // TENANT-SCOPE-EXEMPT: operator console — platform-wide count of every captured event.
    sql`SELECT COUNT(*)::int AS n FROM event`,
    // TENANT-SCOPE-EXEMPT: operator console — platform-wide count of today's captured events.
    sql`SELECT COUNT(*)::int AS n FROM event WHERE ts >= ${today}`,
    sql`SELECT status, COUNT(*)::int AS n FROM "user" GROUP BY status`,
  ]);

  return composeOverview({
    orgs: scalar(orgsRows),
    projects: scalar(projectsRows),
    members: scalar(membersRows),
    liveExperiments: scalar(liveRows),
    activeExperiments: scalar(activeRows),
    archivedExperiments: scalar(archivedRows),
    events: scalar(eventsRows),
    eventsToday: scalar(eventsTodayRows),
    userStatusRows: userStatusRows as unknown as StatusCountRow[],
  });
}

/** Every organization with its rolled-up member / project / experiment counts,
 *  oldest first. The experiment counts JOIN through `project`, so project_id is
 *  the real attribution key here (not a tenant filter). */
export async function listOrgSummaries(): Promise<OrgSummary[]> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT
      o.id,
      o.name,
      o.verified_domain,
      o.created_at,
      (SELECT COUNT(*)::int FROM membership m WHERE m.org_id = o.id) AS member_count,
      (SELECT COUNT(*)::int FROM project p WHERE p.org_id = o.id) AS project_count,
      (SELECT COUNT(*)::int FROM experiment e
         JOIN project p ON p.id = e.project_id
        WHERE p.org_id = o.id) AS live_count,
      (SELECT COUNT(*)::int FROM archived_experiment a
         JOIN project p ON p.id = a.project_id
        WHERE p.org_id = o.id) AS archived_count
    FROM organization o
    ORDER BY o.created_at ASC, o.id ASC
  `) as unknown as OrgSummaryRow[];
  return rows.map(toOrgSummary);
}

/** Every (user, org) membership across the platform — the Members tab. Owners
 *  first within each org, then by email. Optionally scoped to one org (for the
 *  drill-in). Touches only non-scoped tables (membership/user/organization). */
export async function listPlatformMembers(orgId?: string): Promise<PlatformMember[]> {
  await createSchema();
  const sql = getSql();
  const rows = (orgId
    ? await sql`
        SELECT u.id AS user_id, u.email, u.name, u.status AS user_status,
               m.role, m.org_id, o.name AS org_name, m.created_at AS joined_at
        FROM membership m
        JOIN "user" u ON u.id = m.user_id
        JOIN organization o ON o.id = m.org_id
        WHERE m.org_id = ${orgId}
        ORDER BY
          CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,
          u.email ASC
      `
    : await sql`
        SELECT u.id AS user_id, u.email, u.name, u.status AS user_status,
               m.role, m.org_id, o.name AS org_name, m.created_at AS joined_at
        FROM membership m
        JOIN "user" u ON u.id = m.user_id
        JOIN organization o ON o.id = m.org_id
        ORDER BY
          o.name ASC,
          CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,
          u.email ASC
      `) as unknown as MemberRow[];
  return rows.map(toPlatformMember);
}

/** Every experiment (live + archived) across the platform — the Experiments
 *  tab — newest first. Optionally scoped to one org (for the drill-in). Both
 *  halves JOIN through `project`, so project_id is load-bearing attribution. */
export async function listPlatformExperiments(orgId?: string): Promise<PlatformExperiment[]> {
  await createSchema();
  const sql = getSql();
  const rows = (orgId
    ? await sql`
        SELECT 'live' AS kind, e.key, e.name, e.business, e.goal_metric,
               e.active, NULL::text AS archived_status, e.start_date,
               e.created_at, p.org_id, o.name AS org_name
        FROM experiment e
        JOIN project p ON p.id = e.project_id
        JOIN organization o ON o.id = p.org_id
        WHERE p.org_id = ${orgId}
        UNION ALL
        SELECT 'archived' AS kind, a.key, a.name, a.business, a.goal_metric,
               NULL::int AS active, a.status AS archived_status, a.start_date,
               a.imported_at AS created_at, p.org_id, o.name AS org_name
        FROM archived_experiment a
        JOIN project p ON p.id = a.project_id
        JOIN organization o ON o.id = p.org_id
        WHERE p.org_id = ${orgId}
        ORDER BY created_at DESC
      `
    : await sql`
        SELECT 'live' AS kind, e.key, e.name, e.business, e.goal_metric,
               e.active, NULL::text AS archived_status, e.start_date,
               e.created_at, p.org_id, o.name AS org_name
        FROM experiment e
        JOIN project p ON p.id = e.project_id
        JOIN organization o ON o.id = p.org_id
        UNION ALL
        SELECT 'archived' AS kind, a.key, a.name, a.business, a.goal_metric,
               NULL::int AS active, a.status AS archived_status, a.start_date,
               a.imported_at AS created_at, p.org_id, o.name AS org_name
        FROM archived_experiment a
        JOIN project p ON p.id = a.project_id
        JOIN organization o ON o.id = p.org_id
        ORDER BY created_at DESC
      `) as unknown as ExperimentRow[];
  return rows.map(toPlatformExperiment);
}

/** One org's full drill-in (the detail view), or null if no such org. Re-uses
 *  the org-scoped variants of the reads above. */
export async function getOrgDetail(orgId: string): Promise<OrgDetail | null> {
  await createSchema();
  const sql = getSql();

  const orgRows = (await sql`
    SELECT id, name, verified_domain, created_at FROM organization WHERE id = ${orgId}
  `) as unknown as {
    id: string;
    name: string;
    verified_domain: string | null;
    created_at: string;
  }[];
  const orgRow = orgRows[0];
  if (!orgRow) return null;

  const [projectRows, members, experiments] = await Promise.all([
    sql`SELECT id, name, created_at FROM project WHERE org_id = ${orgId} ORDER BY created_at ASC` as unknown as Promise<
      { id: string; name: string; created_at: string }[]
    >,
    listPlatformMembers(orgId),
    listPlatformExperiments(orgId),
  ]);

  const projects = projectRows.map((p) => ({
    id: p.id,
    name: p.name,
    createdAt: p.created_at,
  }));
  const liveExperiments = experiments.filter((e) => e.kind === "live").length;

  return {
    org: {
      id: orgRow.id,
      name: orgRow.name,
      verifiedDomain: orgRow.verified_domain,
      createdAt: orgRow.created_at,
    },
    projects,
    members,
    experiments,
    counts: {
      members: members.length,
      projects: projects.length,
      liveExperiments,
      archivedExperiments: experiments.length - liveExperiments,
    },
  };
}
