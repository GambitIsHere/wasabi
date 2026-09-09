"use server";

// ============================================================================
// Wasabi — per-org Tickets server actions.
// ----------------------------------------------------------------------------
// The write path for the kanban board. Each action:
//   1. gates on requireRole("editor") — a viewer can read the board but not
//      change it (same gate as the experiment-management actions),
//   2. validates the input with the SAME pure rules the board form uses
//      (lib/tickets.ts),
//   3. persists via the server-only, tenant-scoped store (lib/tickets-store.ts),
//   4. revalidates /tickets so the board server component re-reads fresh rows.
//
// All return TicketActionResult — never throw across the server boundary, so
// the board can render a clean inline error. Mirrors app/actions.ts.
// ============================================================================
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/authz";
import {
  isTicketStatus,
  validateTicketInput,
  validateTicketPatch,
  type TicketActionResult,
  type TicketInput,
  type TicketPatch,
} from "@/lib/tickets";
import {
  createTicket,
  deleteTicket,
  moveTicket,
  updateTicket,
  TicketValidationError,
} from "@/lib/tickets-store";

/** Map a thrown store error to a clean action error. A TicketValidationError is
 *  the caller's own fault (a bad assignee) and surfaces verbatim; anything else
 *  is a genuine failure whose message we still pass through, mirroring
 *  app/actions.ts's catch. */
function toError(err: unknown, fallback: string): string {
  if (err instanceof TicketValidationError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

/** Create a ticket. Defaults status to "backlog" and appends to that column. */
export async function createTicketAction(input: TicketInput): Promise<TicketActionResult> {
  const gate = await requireRole("editor");
  if (!gate.ok) return { ok: false, error: gate.error };

  const error = validateTicketInput(input);
  if (error) return { ok: false, error };

  try {
    const id = await createTicket(input);
    revalidatePath("/tickets");
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: toError(err, "Failed to create the ticket.") };
  }
}

/** Patch a ticket's fields. 404s (a clean error) when the id matches no ticket
 *  in the caller's tenant. */
export async function updateTicketAction(
  id: string,
  patch: TicketPatch,
): Promise<TicketActionResult> {
  const gate = await requireRole("editor");
  if (!gate.ok) return { ok: false, error: gate.error };

  const error = validateTicketPatch(patch);
  if (error) return { ok: false, error };

  try {
    const changed = await updateTicket(id, patch);
    if (!changed) return { ok: false, error: "No ticket found to update." };
    revalidatePath("/tickets");
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: toError(err, "Failed to update the ticket.") };
  }
}

/** The kanban drag — move a card to a new column + position. Validates the
 *  target status and that position is a whole number before touching the DB. */
export async function moveTicketAction(
  id: string,
  status: string,
  position: number,
): Promise<TicketActionResult> {
  const gate = await requireRole("editor");
  if (!gate.ok) return { ok: false, error: gate.error };

  if (!isTicketStatus(status)) {
    return { ok: false, error: "Unknown ticket status." };
  }
  if (!Number.isInteger(position) || position < 0) {
    return { ok: false, error: "Position must be a non-negative whole number." };
  }

  try {
    const changed = await moveTicket(id, status, position);
    if (!changed) return { ok: false, error: "No ticket found to move." };
    revalidatePath("/tickets");
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: toError(err, "Failed to move the ticket.") };
  }
}

/** Delete a ticket. */
export async function deleteTicketAction(id: string): Promise<TicketActionResult> {
  const gate = await requireRole("editor");
  if (!gate.ok) return { ok: false, error: gate.error };

  try {
    const removed = await deleteTicket(id);
    if (!removed) return { ok: false, error: "No ticket found to delete." };
    revalidatePath("/tickets");
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: toError(err, "Failed to delete the ticket.") };
  }
}
