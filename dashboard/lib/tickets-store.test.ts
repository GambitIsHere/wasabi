// ============================================================================
// tickets-store.ts — behavioural tests for the tenant-scoped store. DB-touching
// deps (@/lib/db, @/lib/tenant, @/lib/membership) are mocked with a minimal
// recording fake `sql` client — the same vi.mock convention as
// lib/archive.test.ts — so the REAL store logic (position resolution, tenant
// stamping, ownership WHERE, the cross-org assignee guard) runs end to end down
// to the exact SQL it issues, which the fake captures for assertion. No live DB.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ createSchema: vi.fn(), getSql: vi.fn() }));
vi.mock("@/lib/tenant", () => ({
  getCurrentProjectId: vi.fn(),
  getCurrentTenant: vi.fn(),
}));
vi.mock("@/lib/membership", () => ({ getMembership: vi.fn() }));

import { createSchema, getSql } from "@/lib/db";
import { getMembership } from "@/lib/membership";
import { getCurrentProjectId, getCurrentTenant } from "@/lib/tenant";
import {
  createTicket,
  deleteTicket,
  listTickets,
  moveTicket,
  updateTicket,
  TicketValidationError,
} from "@/lib/tickets-store";

const mockCreateSchema = vi.mocked(createSchema);
const mockGetSql = vi.mocked(getSql);
const mockGetCurrentProjectId = vi.mocked(getCurrentProjectId);
const mockGetCurrentTenant = vi.mocked(getCurrentTenant);
const mockGetMembership = vi.mocked(getMembership);

/** One captured `sql\`…\`` invocation: the static text (interpolation points
 *  collapsed to " ? ") and the bound values, in order. */
interface SqlCall {
  text: string;
  values: unknown[];
}
let sqlCalls: SqlCall[] = [];
/** FIFO of results the fake returns, one per `sql\`…\`` call in issue order.
 *  Defaults to `[]` (an empty rowset) when the queue is exhausted. */
let sqlResults: unknown[] = [];

/** Install a fake `sql` tagged-template that records every call and returns the
 *  next queued result. Cast through unknown to the driver's real type at the
 *  boundary — the rest of NeonQueryFunction's surface is never touched here. */
function installFakeSql(): void {
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join(" ? "), values });
    const next = sqlResults.length > 0 ? sqlResults.shift() : [];
    return Promise.resolve(next);
  }) as unknown as ReturnType<typeof getSql>;
  mockGetSql.mockReturnValue(fn);
}

/** A membership row for an in-org assignee (the shape getMembership returns). */
function membership(userId: string, orgId: string) {
  return { userId, orgId, role: "viewer" as const, createdAt: "2026-01-01T00:00:00.000Z" };
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlCalls = [];
  sqlResults = [];
  mockCreateSchema.mockResolvedValue(undefined);
  mockGetCurrentProjectId.mockResolvedValue("proj-1");
  mockGetCurrentTenant.mockResolvedValue({ orgId: "sanjow", projectId: "proj-1" });
  mockGetMembership.mockResolvedValue(null); // "not a member" unless a test says otherwise
  installFakeSql();
});

describe("createTicket", () => {
  it("appends to the end of the target status column, stamping org + project from the tenant", async () => {
    sqlResults = [[{ next_pos: 3 }], []]; // position query, then the INSERT

    const id = await createTicket({ title: "  New idea  ", status: "next" });

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    // First statement: end-of-column position, scoped to this project + status.
    const posCall = sqlCalls[0];
    expect(posCall.text).toMatch(/MAX\(position\)/);
    expect(posCall.text).toMatch(/FROM ticket/);
    expect(posCall.values).toContain("proj-1");
    expect(posCall.values).toContain("next");

    // Second statement: the INSERT, carrying org + project + resolved position,
    // with the title trimmed.
    const insertCall = sqlCalls[1];
    expect(insertCall.text).toMatch(/INSERT INTO ticket/);
    expect(insertCall.values).toContain("sanjow"); // org_id
    expect(insertCall.values).toContain("proj-1"); // project_id
    expect(insertCall.values).toContain(3); // position = max + 1
    expect(insertCall.values).toContain("New idea"); // trimmed title
    expect(insertCall.values).toContain("next"); // status
  });

  it("defaults status to backlog and starts an empty column at position 0", async () => {
    sqlResults = [[{ next_pos: 0 }], []];

    await createTicket({ title: "First card" });

    expect(sqlCalls[0].values).toContain("backlog"); // position query keyed on default status
    expect(sqlCalls[1].values).toContain("backlog");
    expect(sqlCalls[1].values).toContain(0);
  });

  it("rejects an assignee who is not a member of the org, before touching the DB (cross-org guard)", async () => {
    mockGetMembership.mockResolvedValue(null);

    await expect(
      createTicket({ title: "x", assigneeUserId: "outsider" }),
    ).rejects.toBeInstanceOf(TicketValidationError);

    expect(mockGetMembership).toHaveBeenCalledWith("outsider", "sanjow");
    expect(sqlCalls).toEqual([]); // never reached the INSERT
  });

  it("accepts an assignee who IS a member of the org", async () => {
    mockGetMembership.mockResolvedValue(membership("u2", "sanjow"));
    sqlResults = [[{ next_pos: 0 }], []];

    const id = await createTicket({ title: "Assign me", assigneeUserId: "u2" });

    expect(typeof id).toBe("string");
    expect(sqlCalls[1].values).toContain("u2");
  });
});

describe("listTickets", () => {
  it("reads only the current project's tickets, ordered for the board, and maps rows to camelCase", async () => {
    sqlResults = [
      [
        {
          id: "t1", org_id: "sanjow", project_id: "proj-1", title: "A", description: "",
          status: "backlog", assignee_user_id: null, experiment_key: null, position: 0,
          created_at: "2026-01-01", updated_at: "2026-01-02",
        },
        {
          id: "t2", org_id: "sanjow", project_id: "proj-1", title: "B", description: "d",
          status: "running", assignee_user_id: "u2", experiment_key: "exp-1", position: 1,
          created_at: "2026-01-03", updated_at: "2026-01-04",
        },
      ],
    ];

    const tickets = await listTickets();

    const call = sqlCalls[0];
    expect(call.text).toMatch(/FROM ticket/);
    expect(call.text).toMatch(/project_id = /);
    expect(call.text).toMatch(/ORDER BY status ASC, position ASC, created_at ASC/);
    expect(call.values).toContain("proj-1");

    expect(tickets).toEqual([
      {
        id: "t1", orgId: "sanjow", projectId: "proj-1", title: "A", description: "",
        status: "backlog", assigneeUserId: null, experimentKey: null, position: 0,
        createdAt: "2026-01-01", updatedAt: "2026-01-02",
      },
      {
        id: "t2", orgId: "sanjow", projectId: "proj-1", title: "B", description: "d",
        status: "running", assigneeUserId: "u2", experimentKey: "exp-1", position: 1,
        createdAt: "2026-01-03", updatedAt: "2026-01-04",
      },
    ]);
  });

  it("fails an unrecognised stored status soft to backlog rather than crashing", async () => {
    sqlResults = [
      [
        {
          id: "t3", org_id: "sanjow", project_id: "proj-1", title: "C", description: "",
          status: "archived", assignee_user_id: null, experiment_key: null, position: 0,
          created_at: "2026-01-01", updated_at: "2026-01-01",
        },
      ],
    ];

    const tickets = await listTickets();

    expect(tickets[0].status).toBe("backlog");
  });
});

describe("updateTicket", () => {
  it("patches the current tenant's ticket, scoped by id AND project_id, and reports the change", async () => {
    sqlResults = [[{ id: "t1" }]];

    const changed = await updateTicket("t1", { title: "renamed", status: "shipped" });

    expect(changed).toBe(true);
    const call = sqlCalls[0];
    expect(call.text).toMatch(/UPDATE ticket/);
    expect(call.text).toMatch(/project_id = /);
    expect(call.values).toContain("t1");
    expect(call.values).toContain("proj-1");
    expect(call.values).toContain("renamed");
    expect(call.values).toContain("shipped");
  });

  it("no-ops on a foreign-tenant id — the ownership WHERE matches no row (returns false)", async () => {
    sqlResults = [[]]; // RETURNING came back empty

    const changed = await updateTicket("someone-elses-id", { title: "hijack attempt" });

    expect(changed).toBe(false);
    expect(sqlCalls[0].values).toContain("proj-1"); // still scoped to the caller's project
  });

  it("rejects a patch that assigns a cross-org user, before touching the DB", async () => {
    mockGetMembership.mockResolvedValue(null);

    await expect(
      updateTicket("t1", { assigneeUserId: "outsider" }),
    ).rejects.toBeInstanceOf(TicketValidationError);

    expect(mockGetMembership).toHaveBeenCalledWith("outsider", "sanjow");
    expect(sqlCalls).toEqual([]);
  });
});

describe("moveTicket", () => {
  it("sets status + position, scoped by id AND project_id", async () => {
    sqlResults = [[{ id: "t1" }]];

    const ok = await moveTicket("t1", "running", 2);

    expect(ok).toBe(true);
    const call = sqlCalls[0];
    expect(call.text).toMatch(/UPDATE ticket SET status = /);
    expect(call.text).toMatch(/project_id = /);
    expect(call.values).toContain("t1");
    expect(call.values).toContain("proj-1");
    expect(call.values).toContain("running");
    expect(call.values).toContain(2);
  });

  it("no-ops on a foreign-tenant / unknown id", async () => {
    sqlResults = [[]];
    expect(await moveTicket("nope", "backlog", 0)).toBe(false);
  });
});

describe("deleteTicket", () => {
  it("deletes the current tenant's ticket, scoped by id AND project_id", async () => {
    sqlResults = [[{ id: "t1" }]];

    expect(await deleteTicket("t1")).toBe(true);
    const call = sqlCalls[0];
    expect(call.text).toMatch(/DELETE FROM ticket/);
    expect(call.text).toMatch(/project_id = /);
    expect(call.values).toContain("t1");
    expect(call.values).toContain("proj-1");
  });

  it("no-ops on a foreign-tenant / unknown id", async () => {
    sqlResults = [[]];
    expect(await deleteTicket("nope")).toBe(false);
  });
});
