// ============================================================================
// Build-ticket ledger store (server-only) — re-promote idempotency for the
// roadmap→YouTrack loop.
// ----------------------------------------------------------------------------
// One row per YouTrack build ticket the loop has filed (or is filing) for a
// suggested-experiment arm. The whole point is that promoting the same backlog
// ticket + theme slug twice must NEVER file a second YouTrack issue. The DB's
// UNIQUE (org_id, source_ticket, theme_slug) index is the hard guard; this
// module implements CLAIM-FIRST so even two concurrent promotes are safe:
//
//   1. claimBuildTicket() inserts a 'creating' row, relying on ON CONFLICT DO
//      NOTHING against the unique index. If the insert wins, the caller owns the
//      slot and may POST to YouTrack. If it loses (row already there), the caller
//      gets the EXISTING row and must NOT create anything.
//   2. On a successful POST, markBuildTicketCreated() stamps the readable id.
//   3. On a failed POST, releaseBuildTicket() deletes the 'creating' row so a
//      later retry can re-claim the slot (rather than being wedged forever).
//
// Org-scoped exactly like lib/roadmap-store.ts (org_id via getCurrentOrgId), so
// one tenant's ledger never sees another's.
//
// SERVER-ONLY: imports lib/db.ts. Never import from a client component.
// ============================================================================
import { getSql, createSchema } from "./db";
import { getCurrentOrgId } from "./tenant";

export type BuildTicketStatus = "creating" | "created";

export interface BuildTicketRow {
  id: string;
  sourceTicket: string;
  themeSlug: string;
  business: string;
  project: string;
  summary: string;
  createdTicket: string | null;
  status: BuildTicketStatus;
  createdBy: string | null;
  createdAtMs: number;
}

interface RawRow {
  id: string;
  source_ticket: string;
  theme_slug: string;
  business: string;
  project: string;
  summary: string;
  created_ticket: string | null;
  status: string;
  created_by: string | null;
  created_at: string | Date;
}

function toRow(r: RawRow): BuildTicketRow {
  return {
    id: r.id,
    sourceTicket: r.source_ticket,
    themeSlug: r.theme_slug,
    business: r.business,
    project: r.project,
    summary: r.summary,
    createdTicket: r.created_ticket,
    status: r.status === "created" ? "created" : "creating",
    createdBy: r.created_by,
    createdAtMs: new Date(r.created_at).getTime(),
  };
}

let readyPromise: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  return (readyPromise ??= createSchema());
}

/** Every ledger row for the current org — used to tag suggestions that already
 *  have a build ticket so the UI never offers to file a duplicate. */
export async function listBuildTickets(): Promise<BuildTicketRow[]> {
  await ensureReady();
  const sql = getSql();
  const orgId = await getCurrentOrgId();
  const rows = (await sql`
    SELECT * FROM experiment_build_ticket WHERE org_id = ${orgId}
    ORDER BY created_at DESC
  `) as unknown as RawRow[];
  return rows.map(toRow);
}

/** The existing ledger row for one (source ticket, theme slug), or null. */
export async function getBuildTicket(
  sourceTicket: string,
  themeSlug: string,
): Promise<BuildTicketRow | null> {
  await ensureReady();
  const sql = getSql();
  const orgId = await getCurrentOrgId();
  const rows = (await sql`
    SELECT * FROM experiment_build_ticket
    WHERE org_id = ${orgId} AND source_ticket = ${sourceTicket} AND theme_slug = ${themeSlug}
    LIMIT 1
  `) as unknown as RawRow[];
  return rows[0] ? toRow(rows[0]) : null;
}

export interface ClaimInput {
  sourceTicket: string;
  themeSlug: string;
  business: string;
  project: string;
  summary: string;
  createdBy: string | null;
}

export type ClaimResult =
  | { claimed: true; id: string }
  | { claimed: false; existing: BuildTicketRow };

/**
 * Try to claim the (org, source ticket, theme slug) slot for a new build ticket.
 * Returns `{ claimed: true, id }` when this caller won the slot (and must be the
 * one to POST to YouTrack), or `{ claimed: false, existing }` when a row already
 * exists (a prior — or concurrent — promote; the caller must NOT create a
 * duplicate). Relies on the unique index for atomicity.
 */
export async function claimBuildTicket(input: ClaimInput): Promise<ClaimResult> {
  await ensureReady();
  const sql = getSql();
  const orgId = await getCurrentOrgId();
  const id = crypto.randomUUID();
  const inserted = (await sql`
    INSERT INTO experiment_build_ticket
      (id, org_id, source_ticket, theme_slug, business, project, summary, status, created_by)
    VALUES (
      ${id}, ${orgId}, ${input.sourceTicket}, ${input.themeSlug}, ${input.business},
      ${input.project}, ${input.summary}, 'creating', ${input.createdBy}
    )
    ON CONFLICT (org_id, source_ticket, theme_slug) DO NOTHING
    RETURNING id
  `) as unknown as { id: string }[];

  if (inserted.length > 0) return { claimed: true, id };

  // Lost the race (or a prior promote already claimed it) — hand back the winner.
  const existing = await getBuildTicket(input.sourceTicket, input.themeSlug);
  if (existing) return { claimed: false, existing };
  // Extremely unlikely: conflict but no row (a concurrent delete between the
  // INSERT and the SELECT). Surface as claimed-false with a synthetic row rather
  // than pretending we own the slot.
  return {
    claimed: false,
    existing: {
      id: "",
      sourceTicket: input.sourceTicket,
      themeSlug: input.themeSlug,
      business: input.business,
      project: input.project,
      summary: input.summary,
      createdTicket: null,
      status: "creating",
      createdBy: input.createdBy,
      createdAtMs: Date.now(),
    },
  };
}

/** Stamp a claimed row with the created YouTrack issue id. */
export async function markBuildTicketCreated(
  id: string,
  createdTicket: string,
): Promise<void> {
  await ensureReady();
  const sql = getSql();
  const orgId = await getCurrentOrgId();
  await sql`
    UPDATE experiment_build_ticket
    SET created_ticket = ${createdTicket}, status = 'created'
    WHERE id = ${id} AND org_id = ${orgId}
  `;
}

/** Delete a still-'creating' claim after a failed POST, so a retry can re-claim.
 *  Only deletes rows that never reached 'created' — a real ticket is never
 *  removed. */
export async function releaseBuildTicket(id: string): Promise<void> {
  await ensureReady();
  const sql = getSql();
  const orgId = await getCurrentOrgId();
  await sql`
    DELETE FROM experiment_build_ticket
    WHERE id = ${id} AND org_id = ${orgId} AND status = 'creating'
  `;
}
