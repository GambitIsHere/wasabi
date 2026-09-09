import { describe, expect, it } from "vitest";
import { endOfColumnPosition, groupTicketsByStatus } from "./tickets-board";
import { TICKET_STATUSES, type Ticket, type TicketStatus } from "./tickets";

/** Minimal Ticket factory — only the fields the board helpers read matter
 *  (status, position, createdAt, id); everything else gets a harmless default. */
function mk(partial: Partial<Ticket> & { id: string }): Ticket {
  return {
    id: partial.id,
    orgId: partial.orgId ?? "org",
    projectId: partial.projectId ?? "proj",
    title: partial.title ?? `Ticket ${partial.id}`,
    description: partial.description ?? "",
    status: partial.status ?? "backlog",
    assigneeUserId: partial.assigneeUserId ?? null,
    experimentKey: partial.experimentKey ?? null,
    position: partial.position ?? 0,
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("groupTicketsByStatus", () => {
  it("returns every status column even when the input is empty", () => {
    const groups = groupTicketsByStatus([]);
    expect(Object.keys(groups).sort()).toEqual([...TICKET_STATUSES].sort());
    for (const status of TICKET_STATUSES) {
      expect(groups[status]).toEqual([]);
    }
  });

  it("routes each ticket into its own status column", () => {
    const tickets = [
      mk({ id: "a", status: "backlog" }),
      mk({ id: "b", status: "next" }),
      mk({ id: "c", status: "running" }),
      mk({ id: "d", status: "shipped" }),
      mk({ id: "e", status: "backlog" }),
    ];
    const groups = groupTicketsByStatus(tickets);
    expect(groups.backlog.map((t) => t.id)).toEqual(["a", "e"]);
    expect(groups.next.map((t) => t.id)).toEqual(["b"]);
    expect(groups.running.map((t) => t.id)).toEqual(["c"]);
    expect(groups.shipped.map((t) => t.id)).toEqual(["d"]);
  });

  it("orders a column by position, then createdAt as a tiebreaker", () => {
    const tickets = [
      mk({ id: "later-pos", status: "backlog", position: 2, createdAt: "2026-01-01T00:00:00.000Z" }),
      mk({ id: "tie-newer", status: "backlog", position: 0, createdAt: "2026-02-01T00:00:00.000Z" }),
      mk({ id: "tie-older", status: "backlog", position: 0, createdAt: "2026-01-01T00:00:00.000Z" }),
      mk({ id: "mid-pos", status: "backlog", position: 1, createdAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(groupTicketsByStatus(tickets).backlog.map((t) => t.id)).toEqual([
      "tie-older",
      "tie-newer",
      "mid-pos",
      "later-pos",
    ]);
  });

  it("does not mutate the input array order", () => {
    const tickets = [
      mk({ id: "a", status: "backlog", position: 5 }),
      mk({ id: "b", status: "backlog", position: 1 }),
    ];
    groupTicketsByStatus(tickets);
    expect(tickets.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("endOfColumnPosition", () => {
  const tickets = [
    mk({ id: "a", status: "backlog" }),
    mk({ id: "b", status: "backlog" }),
    mk({ id: "c", status: "next" }),
  ];

  it("is the count of cards already in the target column", () => {
    expect(endOfColumnPosition(tickets, "backlog")).toBe(2);
    expect(endOfColumnPosition(tickets, "next")).toBe(1);
  });

  it("is 0 for an empty column", () => {
    expect(endOfColumnPosition(tickets, "shipped")).toBe(0);
    expect(endOfColumnPosition([], "backlog")).toBe(0);
  });

  it("excludes the moving card so it never counts itself", () => {
    // A card already in `backlog` dropped back onto backlog counts its sibling
    // only (1), never itself — matching the store's dense 0..n-1 convention.
    expect(endOfColumnPosition(tickets, "backlog", "a")).toBe(1);
    // Excluding a card from a column it isn't in changes nothing.
    expect(endOfColumnPosition(tickets, "next", "a")).toBe(1);
  });

  it("covers every status", () => {
    for (const status of TICKET_STATUSES as readonly TicketStatus[]) {
      expect(endOfColumnPosition(tickets, status)).toBeGreaterThanOrEqual(0);
    }
  });
});
