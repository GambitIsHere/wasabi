// ============================================================================
// lib/platform-types.ts — pure, dependency-free types + presentation helpers
// for the Sanjow operator console (the cross-org super-admin backoffice).
// ----------------------------------------------------------------------------
// Kept SEPARATE from lib/platform.ts (which imports the DB layer and is
// server-only) so a client component can import these types + the pure
// experimentStatus() helper WITHOUT dragging the Neon driver into the browser
// bundle. Same split lib/roles.ts uses for the membership types. Only
// lib/roles.ts (pure) is imported here.
// ============================================================================
import type { MembershipRole, UserStatus } from "./roles";

/** Mirrors lib/archive.ts's ArchivedStatus union (re-declared here rather than
 *  imported so this client-importable file never reaches through
 *  lib/archive.ts → lib/db.ts). Kept in sync by hand; the 4 values are stable. */
export type ArchivedStatus = "winner" | "inconclusive" | "lost" | "archived";

/** Platform-wide headline counts — the Overview tab's KPI strip. Every number
 *  is cross-org (all tenants), which is exactly why the reads behind it are
 *  gated by requireSuperAdmin (see lib/platform.ts). */
export interface PlatformOverview {
  orgs: number;
  projects: number;
  /** Total membership rows across every org (a user in two orgs counts twice). */
  members: number;
  activeUsers: number;
  pendingUsers: number;
  suspendedUsers: number;
  /** All live experiments (the `experiment` table) across every project. */
  liveExperiments: number;
  /** The subset of liveExperiments currently running (active = 1). */
  activeExperiments: number;
  /** All imported/archived experiments across every project. */
  archivedExperiments: number;
  /** Total assignment/conversion events captured (the `event` table). */
  events: number;
  eventsToday: number;
}

/** One organization row for the Orgs tab, with its rolled-up counts. */
export interface OrgSummary {
  id: string;
  name: string;
  verifiedDomain: string | null;
  createdAt: string;
  memberCount: number;
  projectCount: number;
  liveExperimentCount: number;
  archivedExperimentCount: number;
}

/** One (user, org) membership for the Members tab — cross-org, so the org is
 *  carried on every row. userStatus is the account-level status; role is the
 *  per-org membership role. */
export interface PlatformMember {
  userId: string;
  email: string;
  name: string | null;
  userStatus: UserStatus;
  role: MembershipRole;
  orgId: string;
  orgName: string;
  joinedAt: string;
}

export type PlatformExperimentKind = "live" | "archived";

/** One experiment (live OR archived) for the Experiments tab, attributed to its
 *  owning org. `active` is set only for live; `archivedStatus` only for archived. */
export interface PlatformExperiment {
  kind: PlatformExperimentKind;
  key: string;
  name: string;
  business: string;
  goalMetric: string | null;
  active: boolean | null;
  archivedStatus: ArchivedStatus | null;
  startDate: string | null;
  /** created_at for a live experiment; imported_at for an archived one. */
  createdAt: string | null;
  orgId: string;
  orgName: string;
}

/** One org's full drill-in — the detail view behind the Orgs tab. */
export interface OrgDetail {
  org: {
    id: string;
    name: string;
    verifiedDomain: string | null;
    createdAt: string;
  };
  projects: { id: string; name: string; createdAt: string }[];
  members: PlatformMember[];
  experiments: PlatformExperiment[];
  counts: {
    members: number;
    projects: number;
    liveExperiments: number;
    archivedExperiments: number;
  };
}

// ---------------------------------------------------------------------------
// Pure presentation helper — the status label + colour tone for any experiment
// row, shared by the badge component and unit-tested directly (no DB, no DOM).
// ---------------------------------------------------------------------------

export type StatusTone = "good" | "warn" | "bad" | "info" | "faint";

/** The badge label + tone for a platform experiment: live experiments read
 *  Active/Paused; archived ones read their stored verdict (winner/lost/…). */
export function experimentStatus(exp: {
  kind: PlatformExperimentKind;
  active: boolean | null;
  archivedStatus: ArchivedStatus | null;
}): { label: string; tone: StatusTone } {
  if (exp.kind === "live") {
    return exp.active
      ? { label: "Active", tone: "good" }
      : { label: "Paused", tone: "faint" };
  }
  switch (exp.archivedStatus) {
    case "winner":
      return { label: "Winner", tone: "good" };
    case "lost":
      return { label: "Lost", tone: "bad" };
    case "inconclusive":
      return { label: "Inconclusive", tone: "warn" };
    default:
      return { label: "Archived", tone: "faint" };
  }
}
