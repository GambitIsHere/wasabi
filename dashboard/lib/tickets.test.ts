// ============================================================================
// tickets.ts — behavioural tests for the pure domain module: the status guard,
// the status metadata, and both validators. All plain TypeScript, no DB — the
// same DB-free convention the rest of lib/*.test.ts follows.
// ============================================================================
import { describe, expect, it } from "vitest";
import {
  TICKET_DESCRIPTION_MAX,
  TICKET_STATUS_META,
  TICKET_STATUSES,
  TICKET_TITLE_MAX,
  isTicketStatus,
  validateTicketInput,
  validateTicketPatch,
  type TicketInput,
  type TicketPatch,
} from "@/lib/tickets";

describe("isTicketStatus", () => {
  it("accepts every canonical status", () => {
    for (const status of TICKET_STATUSES) {
      expect(isTicketStatus(status)).toBe(true);
    }
  });

  it("rejects unknown strings and non-strings", () => {
    expect(isTicketStatus("done")).toBe(false);
    expect(isTicketStatus("Backlog")).toBe(false); // case-sensitive
    expect(isTicketStatus("")).toBe(false);
    expect(isTicketStatus(null)).toBe(false);
    expect(isTicketStatus(undefined)).toBe(false);
    expect(isTicketStatus(3)).toBe(false);
    expect(isTicketStatus({})).toBe(false);
  });
});

describe("TICKET_STATUS_META", () => {
  it("labels every status, and only the canonical ones", () => {
    expect(Object.keys(TICKET_STATUS_META).sort()).toEqual([...TICKET_STATUSES].sort());
    expect(TICKET_STATUS_META.backlog.label).toBe("Backlog");
    expect(TICKET_STATUS_META.next.label).toBe("Next");
    expect(TICKET_STATUS_META.running.label).toBe("Running");
    expect(TICKET_STATUS_META.shipped.label).toBe("Shipped");
  });

  it("keeps the columns in board order (also ascending alphabetical)", () => {
    expect([...TICKET_STATUSES]).toEqual(["backlog", "next", "running", "shipped"]);
    expect([...TICKET_STATUSES]).toEqual([...TICKET_STATUSES].sort());
  });
});

describe("validateTicketInput", () => {
  function input(overrides: Partial<TicketInput> = {}): TicketInput {
    return { title: "Test the new pricing card", ...overrides };
  }

  it("passes a minimal valid input (title only)", () => {
    expect(validateTicketInput(input())).toBeNull();
  });

  it("passes with every optional field set", () => {
    expect(
      validateTicketInput(
        input({
          description: "Run the 9€ vs 5€ variant on TU checkout.",
          status: "running",
          assigneeUserId: "u1",
          experimentKey: "tu-billing-uk",
        }),
      ),
    ).toBeNull();
  });

  it("rejects an empty or whitespace-only title", () => {
    expect(validateTicketInput(input({ title: "" }))).toBe("Title is required.");
    expect(validateTicketInput(input({ title: "   " }))).toBe("Title is required.");
  });

  it("rejects a title over the cap (measured after trimming)", () => {
    expect(validateTicketInput(input({ title: "a".repeat(TICKET_TITLE_MAX + 1) }))).toBe(
      `Title must be ${TICKET_TITLE_MAX} characters or fewer.`,
    );
    // Exactly at the cap is allowed; surrounding whitespace is trimmed off first.
    expect(validateTicketInput(input({ title: "a".repeat(TICKET_TITLE_MAX) }))).toBeNull();
    expect(
      validateTicketInput(input({ title: `  ${"a".repeat(TICKET_TITLE_MAX)}  ` })),
    ).toBeNull();
  });

  it("rejects a description over the cap", () => {
    expect(
      validateTicketInput(input({ description: "d".repeat(TICKET_DESCRIPTION_MAX + 1) })),
    ).toBe(`Description must be ${TICKET_DESCRIPTION_MAX} characters or fewer.`);
    expect(
      validateTicketInput(input({ description: "d".repeat(TICKET_DESCRIPTION_MAX) })),
    ).toBeNull();
  });

  it("rejects an unknown status when present", () => {
    expect(
      validateTicketInput(input({ status: "done" as unknown as TicketInput["status"] })),
    ).toBe(`Status must be one of ${TICKET_STATUSES.join(", ")}.`);
  });
});

describe("validateTicketPatch", () => {
  it("passes an empty patch — nothing to check", () => {
    expect(validateTicketPatch({})).toBeNull();
  });

  it("checks a title only when the patch carries one", () => {
    expect(validateTicketPatch({ title: "A fine new title" })).toBeNull();
    expect(validateTicketPatch({ title: "" })).toBe("Title is required.");
    expect(validateTicketPatch({ description: "no title here, that's fine" })).toBeNull();
  });

  it("checks description and status when present", () => {
    expect(validateTicketPatch({ description: "d".repeat(TICKET_DESCRIPTION_MAX + 1) })).toBe(
      `Description must be ${TICKET_DESCRIPTION_MAX} characters or fewer.`,
    );
    expect(
      validateTicketPatch({ status: "shipping" as unknown as TicketPatch["status"] }),
    ).toBe(`Status must be one of ${TICKET_STATUSES.join(", ")}.`);
    expect(validateTicketPatch({ status: "shipped" })).toBeNull();
  });

  it("allows clearing the assignee / experiment link (explicit null)", () => {
    expect(validateTicketPatch({ assigneeUserId: null, experimentKey: null })).toBeNull();
  });
});
