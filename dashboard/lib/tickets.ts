// ============================================================================
// Wasabi — per-org Tickets: pure domain model + validation (client-safe).
// ----------------------------------------------------------------------------
// A ticket is one card on an org's kanban board — an experiment idea or task the
// org tracks through backlog → next → running → shipped. This is a NEW
// first-class per-org entity, DISTINCT from the code-seeded roadmap timeline
// (lib/roadmap.ts): the roadmap is a fixed, time-based runway; tickets are the
// org's own, freely-created, freely-moved backlog.
//
// PURE + CLIENT-SAFE: this module imports NOTHING server-only (no lib/db.ts, no
// node built-ins) so the board UI (a client component) can import the types, the
// status metadata, and the validators directly — the exact same validation runs
// on the client (instant form feedback) and on the server (the authority). All
// DB access lives in lib/tickets-store.ts; all write authorization in
// app/tickets/actions.ts. Mirrors how lib/mgmt.ts is the pure twin of
// lib/store.ts.
// ============================================================================

/** The kanban columns, in board order (left → right). Also, by luck, ascending
 *  alphabetical — so `ORDER BY status ASC` in the store groups columns in this
 *  same order without a CASE expression. */
export const TICKET_STATUSES = ["backlog", "next", "running", "shipped"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Runtime narrowing for a value off an untyped boundary (client JSON, a DB
 *  string). Accepts `unknown` so callers don't have to pre-cast. */
export function isTicketStatus(value: unknown): value is TicketStatus {
  return typeof value === "string" && (TICKET_STATUSES as readonly string[]).includes(value);
}

/** Per-status display metadata. A record (not a bare label map) so a colour /
 *  accent can be added later without changing call sites. Column header text
 *  the board renders. */
export const TICKET_STATUS_META: Readonly<Record<TicketStatus, { label: string }>> = {
  backlog: { label: "Backlog" },
  next: { label: "Next" },
  running: { label: "Running" },
  shipped: { label: "Shipped" },
};

/** One ticket, as the app sees it (camelCase; the store maps to/from the
 *  snake_case row). `assigneeUserId` is a member of the owning org or null;
 *  `experimentKey` is a LOOSE link to an experiment (a plain string, never a
 *  foreign key — experiments get archived/deleted out from under a ticket, the
 *  same way experiment.youtrackTicket is a loose reference). */
export interface Ticket {
  id: string;
  orgId: string;
  projectId: string;
  title: string;
  description: string;
  status: TicketStatus;
  assigneeUserId: string | null;
  experimentKey: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** What a create accepts. Only `title` is required; everything else defaults
 *  (description → "", status → "backlog", assignee/experiment → null). */
export interface TicketInput {
  title: string;
  description?: string;
  status?: TicketStatus;
  assigneeUserId?: string | null;
  experimentKey?: string | null;
}

/** A partial edit — every field optional. A field left `undefined` is kept at
 *  its stored value; `assigneeUserId`/`experimentKey` set explicitly to `null`
 *  clear the assignment / link (that's why the store can't use the roadmap's
 *  COALESCE-with-null trick, which can't tell "omitted" from "set to null"). */
export interface TicketPatch {
  title?: string;
  description?: string;
  status?: TicketStatus;
  assigneeUserId?: string | null;
  experimentKey?: string | null;
}

/** Server-action result. Tickets are addressed by `id` (a UUID), not a slug
 *  key — so this can't reuse lib/mgmt.ts's ActionResult (which carries `key`).
 *  Lives here, in the client-safe module, so the board UI shares the exact
 *  shape it has to narrow on. */
export type TicketActionResult = { ok: true; id: string } | { ok: false; error: string };

/** Trimmed title length cap — long enough for a real one-line summary, short
 *  enough that a card renders without wrapping into a paragraph. */
export const TICKET_TITLE_MAX = 200;
/** Description cap — a card holds a short note, not a spec. */
export const TICKET_DESCRIPTION_MAX = 2000;

function checkTitle(title: unknown): string | null {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (trimmed.length === 0) return "Title is required.";
  if (trimmed.length > TICKET_TITLE_MAX) {
    return `Title must be ${TICKET_TITLE_MAX} characters or fewer.`;
  }
  return null;
}

function checkDescription(description: string): string | null {
  if (description.length > TICKET_DESCRIPTION_MAX) {
    return `Description must be ${TICKET_DESCRIPTION_MAX} characters or fewer.`;
  }
  return null;
}

function checkStatus(status: unknown): string | null {
  if (!isTicketStatus(status)) {
    return `Status must be one of ${TICKET_STATUSES.join(", ")}.`;
  }
  return null;
}

/**
 * Validate a create. Returns the first human-readable problem, or null when the
 * input is sound. Pure — the SAME check the form runs for instant feedback and
 * the create action runs as the authority. Title is required (non-empty after
 * trimming, within the length cap); description and status are validated only
 * when present.
 */
export function validateTicketInput(input: TicketInput): string | null {
  const titleError = checkTitle(input.title);
  if (titleError) return titleError;
  if (input.description !== undefined) {
    const descriptionError = checkDescription(input.description);
    if (descriptionError) return descriptionError;
  }
  if (input.status !== undefined) {
    const statusError = checkStatus(input.status);
    if (statusError) return statusError;
  }
  return null;
}

/**
 * Validate a partial edit. Every field is optional, so each is checked only
 * when the patch carries it — a title present must still be non-empty and
 * within the cap, a description present within its cap, a status present a real
 * status. Companion to validateTicketInput for the update path (a patch has no
 * required title, so it can't reuse the create validator).
 */
export function validateTicketPatch(patch: TicketPatch): string | null {
  if (patch.title !== undefined) {
    const titleError = checkTitle(patch.title);
    if (titleError) return titleError;
  }
  if (patch.description !== undefined) {
    const descriptionError = checkDescription(patch.description);
    if (descriptionError) return descriptionError;
  }
  if (patch.status !== undefined) {
    const statusError = checkStatus(patch.status);
    if (statusError) return statusError;
  }
  return null;
}
