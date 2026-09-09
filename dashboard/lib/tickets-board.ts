// ============================================================================
// Wasabi — per-org Tickets: pure board-view helpers (client-safe).
// ----------------------------------------------------------------------------
// The tiny bit of pure logic the kanban board (components/tickets/TicketBoard)
// leans on: fold a flat ticket list into per-status columns, and compute the
// end-of-column drop position for a card moved between columns. Kept OUT of the
// board component so it can be unit-tested without a DOM (vitest is node-env —
// see vitest.config.ts) and reused by the optimistic re-group after a drag.
//
// PURE + CLIENT-SAFE: imports only the client-safe domain module
// (lib/tickets.ts) — no lib/db.ts, no server-only code — so the board (a client
// component) imports it directly. Mirrors how lib/tickets.ts is itself the pure
// twin of the server-only lib/tickets-store.ts.
// ============================================================================
import { TICKET_STATUSES, type Ticket, type TicketStatus } from "./tickets";

/** A flat ticket list folded into its four columns, keyed by status. Every
 *  status is always present (an empty column is `[]`, never missing), so the
 *  board can render all four columns without a per-key guard. */
export type TicketsByStatus = Record<TicketStatus, Ticket[]>;

/**
 * Group tickets into columns keyed by status, each column ordered by `position`
 * then `createdAt` as a stable tiebreaker — the SAME order
 * lib/tickets-store.ts's listTickets returns from SQL (ORDER BY status,
 * position, created_at). Reproduced client-side so an OPTIMISTIC re-group right
 * after a drag stays correctly ordered without waiting on a server round-trip.
 * Every status key is initialised, so a status with no tickets is an empty
 * array rather than absent.
 */
export function groupTicketsByStatus(tickets: Ticket[]): TicketsByStatus {
  const groups = {} as TicketsByStatus;
  for (const status of TICKET_STATUSES) groups[status] = [];
  for (const ticket of tickets) groups[ticket.status].push(ticket);
  for (const status of TICKET_STATUSES) {
    groups[status].sort(
      (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt),
    );
  }
  return groups;
}

/**
 * The drop position for a card moved to the END of the `status` column: the
 * count of cards already there. `excludeId` drops the moving card from the
 * count if it happens to be in that column already, so a same-column reorder
 * would still land past its current siblings rather than counting itself. This
 * matches lib/tickets-store.ts's create convention — COALESCE(MAX(position),
 * -1) + 1 — whenever a column's positions are a dense 0..n-1 run, which the
 * board maintains by always appending.
 */
export function endOfColumnPosition(
  tickets: Ticket[],
  status: TicketStatus,
  excludeId?: string,
): number {
  let count = 0;
  for (const ticket of tickets) {
    if (ticket.status === status && ticket.id !== excludeId) count += 1;
  }
  return count;
}
