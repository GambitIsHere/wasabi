// ============================================================================
// Wasabi — per-org Tickets store (server-only, tenant-scoped).
// ----------------------------------------------------------------------------
// The runtime source of truth for each org's kanban board. Every row belongs to
// one project (project_id, the scope key — same choice as experiment/event/
// metric, see lib/tenant.ts); org_id is stored alongside for a future
// account-wide operator view but is NOT the read scope. Mirrors
// lib/roadmap-store.ts: an ensureReady()/createSchema guard, an ownership WHERE
// on every write (id AND project_id, so a foreign-tenant id is a harmless
// no-op), and a validation-error class the action maps to a clean 400-style
// message. UNLIKE roadmap-store, there is NO seeding — a fresh org's board
// starts empty.
//
// SERVER-ONLY: imports lib/db.ts (Neon Postgres). Never import from a client
// component — the board UI imports the pure lib/tickets.ts instead. All DB
// access is async, so every public function returns a Promise.
// ============================================================================
import { createSchema, getSql } from "./db";
import { getMembership } from "./membership";
import { getCurrentProjectId, getCurrentTenant } from "./tenant";
import {
  isTicketStatus,
  type Ticket,
  type TicketInput,
  type TicketPatch,
  type TicketStatus,
} from "./tickets";

// Defence-in-depth: never ship the DB layer to the browser.
if (typeof window !== "undefined") {
  throw new Error("lib/tickets-store.ts is server-only and must not run in the browser.");
}

// ---------------------------------------------------------------------------
// Row shape (snake_case, as stored) + mapper
// ---------------------------------------------------------------------------

interface TicketRow {
  id: string;
  org_id: string;
  project_id: string;
  title: string;
  description: string;
  status: string;
  assignee_user_id: string | null;
  experiment_key: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    title: row.title,
    description: row.description ?? "",
    // Fail an unrecognised stored status to "backlog" rather than crash a render
    // or leak a bad value — same fail-soft posture as roadmap-store's toStatus.
    status: isTicketStatus(row.status) ? row.status : "backlog",
    assigneeUserId: row.assignee_user_id,
    experimentKey: row.experiment_key,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Thrown for a caller-fixable write (e.g. an assignee who isn't a member of
 *  the org). The action maps it to a clean `{ ok:false, error }` rather than a
 *  500 — mirrors lib/roadmap-store.ts's RoadmapValidationError. */
export class TicketValidationError extends Error {}

/**
 * Guard against a cross-org assignment: an assignee must be a member of the
 * ticket's own org, or the write is rejected. getMembership returns null for a
 * user who has no membership in `orgId` — which is exactly a user from another
 * org (or no such user) — so a card can never be assigned across the tenant
 * boundary. experimentKey stays deliberately loose (no existence check): an
 * experiment may be archived/deleted after the link is made.
 */
async function assertAssigneeInOrg(assigneeUserId: string, orgId: string): Promise<void> {
  const membership = await getMembership(assigneeUserId, orgId);
  if (!membership) {
    throw new TicketValidationError("Assignee must be a member of this workspace.");
  }
}

// ---------------------------------------------------------------------------
// Ready guard — create the schema once. NO seeding (a fresh board is empty).
// ---------------------------------------------------------------------------

let readyPromise: Promise<void> | null = null;

function ensureReady(): Promise<void> {
  return (readyPromise ??= createSchema());
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every ticket for the current project, ordered for the board: by status (which
 * is ascending-alphabetical == board column order), then position within the
 * column, then created_at as a stable tiebreaker. Scoped by project_id — a
 * different project's cards never appear.
 */
export async function listTickets(): Promise<Ticket[]> {
  await ensureReady();
  const sql = getSql();
  const projectId = await getCurrentProjectId();
  const rows = (await sql`
    SELECT * FROM ticket
    WHERE project_id = ${projectId}
    ORDER BY status ASC, position ASC, created_at ASC
  `) as unknown as TicketRow[];
  return rows.map(toTicket);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create a ticket in the current tenant. Resolves org + project from
 * getCurrentTenant(); defaults status to "backlog"; places the card at the END
 * of its target status column (max(position)+1 within this project+status).
 * Validates the assignee against the org before inserting. Returns the new id
 * (a UUID, like lib/users.ts's user ids).
 */
export async function createTicket(input: TicketInput): Promise<string> {
  await ensureReady();
  const { orgId, projectId } = await getCurrentTenant();

  if (input.assigneeUserId != null) {
    await assertAssigneeInOrg(input.assigneeUserId, orgId);
  }

  const status: TicketStatus = input.status ?? "backlog";
  const sql = getSql();

  // End-of-column position: one past the current max within THIS project's
  // column. COALESCE(..., -1) + 1 makes the first card in an empty column 0.
  const posRows = (await sql`
    SELECT COALESCE(MAX(position), -1) + 1 AS next_pos
    FROM ticket
    WHERE project_id = ${projectId} AND status = ${status}
  `) as unknown as { next_pos: number }[];
  const position = posRows[0]?.next_pos ?? 0;

  const id = crypto.randomUUID();
  await sql`
    INSERT INTO ticket
      (id, org_id, project_id, title, description, status, assignee_user_id, experiment_key, position)
    VALUES (
      ${id}, ${orgId}, ${projectId}, ${input.title.trim()}, ${input.description ?? ""},
      ${status}, ${input.assigneeUserId ?? null}, ${input.experimentKey ?? null}, ${position}
    )
  `;
  return id;
}

/**
 * Patch a ticket's editable fields (title / description / status / assignee /
 * experiment link) and bump updated_at. Ownership-scoped (id AND project_id):
 * a foreign-tenant id matches no row and returns false. A CASE-per-field write
 * (not the roadmap's COALESCE trick) so a patch can set assignee_user_id /
 * experiment_key back to NULL — COALESCE(null, stored) can't express that.
 * Returns whether a row matched and was written.
 */
export async function updateTicket(id: string, patch: TicketPatch): Promise<boolean> {
  await ensureReady();
  const { orgId, projectId } = await getCurrentTenant();

  if (patch.assigneeUserId != null) {
    await assertAssigneeInOrg(patch.assigneeUserId, orgId);
  }

  const setTitle = patch.title !== undefined;
  const setDescription = patch.description !== undefined;
  const setStatus = patch.status !== undefined;
  const setAssignee = patch.assigneeUserId !== undefined;
  const setExperiment = patch.experimentKey !== undefined;

  const sql = getSql();
  // Each column takes the patch value only when the patch carries that field,
  // otherwise keeps its stored value. The explicit ::text casts give a bound
  // NULL a concrete type (Postgres can't infer a bare NULL param) — same reason
  // as lib/roadmap-store.ts. updated_at always advances on a matched row.
  const rows = (await sql`
    UPDATE ticket SET
      title            = CASE WHEN ${setTitle}      THEN ${patch.title ?? null}::text ELSE title END,
      description      = CASE WHEN ${setDescription} THEN ${patch.description ?? null}::text ELSE description END,
      status           = CASE WHEN ${setStatus}     THEN ${patch.status ?? null}::text ELSE status END,
      assignee_user_id = CASE WHEN ${setAssignee}   THEN ${patch.assigneeUserId ?? null}::text ELSE assignee_user_id END,
      experiment_key   = CASE WHEN ${setExperiment} THEN ${patch.experimentKey ?? null}::text ELSE experiment_key END,
      updated_at       = now()
    WHERE id = ${id} AND project_id = ${projectId}
    RETURNING id
  `) as unknown as { id: string }[];
  return rows.length > 0;
}

/**
 * The kanban drag: set a card's status + position and bump updated_at,
 * ownership-scoped. Deliberately simple (v1 SIMPLIFICATION): it writes ONLY the
 * dragged card and trusts the client to send sane positions — it does NOT
 * renumber the card's new or old siblings server-side. Returns whether a row
 * matched (false for a foreign-tenant / unknown id).
 */
export async function moveTicket(
  id: string,
  status: TicketStatus,
  position: number,
): Promise<boolean> {
  await ensureReady();
  const projectId = await getCurrentProjectId();
  const sql = getSql();
  const rows = (await sql`
    UPDATE ticket SET status = ${status}, position = ${position}, updated_at = now()
    WHERE id = ${id} AND project_id = ${projectId}
    RETURNING id
  `) as unknown as { id: string }[];
  return rows.length > 0;
}

/** Delete a ticket, ownership-scoped (id AND project_id). Returns whether a row
 *  was removed — false for a foreign-tenant / unknown id. */
export async function deleteTicket(id: string): Promise<boolean> {
  await ensureReady();
  const projectId = await getCurrentProjectId();
  const sql = getSql();
  const rows = (await sql`
    DELETE FROM ticket WHERE id = ${id} AND project_id = ${projectId} RETURNING id
  `) as unknown as { id: string }[];
  return rows.length > 0;
}
