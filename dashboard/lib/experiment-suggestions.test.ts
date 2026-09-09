// ============================================================================
// experiment-suggestions.ts — the roadmap enrichment over the backlog scan.
// ----------------------------------------------------------------------------
// getExperimentBacklog is REUSED, not rebuilt, so we partial-mock @/lib/backlog
// (keeping the real suggestedName / suggestedThemeSlug and only stubbing the
// YouTrack-hitting getExperimentBacklog). @/lib/store and @/lib/build-ticket-store
// are fully mocked. Covers: prefill params, already-promoted dedupe (bare id AND
// full URL), ledger dedupe, and graceful degradation when a read fails.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backlog", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/backlog")>();
  return { ...actual, getExperimentBacklog: vi.fn() };
});
vi.mock("@/lib/store", () => ({ listExperiments: vi.fn() }));
vi.mock("@/lib/build-ticket-store", () => ({ listBuildTickets: vi.fn() }));

import { getExperimentBacklog, type Backlog, type BacklogTicket } from "@/lib/backlog";
import { listExperiments } from "@/lib/store";
import { listBuildTickets } from "@/lib/build-ticket-store";
import {
  getExperimentSuggestions,
  extractTicketId,
} from "@/lib/experiment-suggestions";

const mockBacklog = vi.mocked(getExperimentBacklog);
const mockListExperiments = vi.mocked(listExperiments);
const mockListBuildTickets = vi.mocked(listBuildTickets);

function ticket(overrides: Partial<BacklogTicket> & { id: string }): BacklogTicket {
  return {
    id: overrides.id,
    summary: overrides.summary ?? "TU - A/B test the header",
    description: overrides.description ?? "",
    resolved: overrides.resolved ?? false,
    project: "GP",
    projectName: "Global Product",
    assignee: null,
    ticketType: "User Story",
    tags: [],
    url: `https://sanjow.youtrack.cloud/issue/${overrides.id}`,
    updatedMs: 0,
    business: overrides.business ?? "Top Up",
  };
}

function backlog(tickets: BacklogTicket[]): Backlog {
  return {
    configured: true,
    source: "heuristic",
    query: "…",
    openOnly: true,
    tickets,
    generatedAtMs: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListExperiments.mockResolvedValue([]);
  mockListBuildTickets.mockResolvedValue([]);
});

describe("getExperimentSuggestions — prefill", () => {
  it("derives name + theme + promote params from each backlog ticket (reusing the scan)", async () => {
    mockBacklog.mockResolvedValue(
      backlog([
        ticket({
          id: "GP-100",
          summary: "TU - New theme tu_lov_uk_19 split test",
          description: "run the A/B",
        }),
      ]),
    );

    const { suggestions } = await getExperimentSuggestions();
    expect(suggestions).toHaveLength(1);
    const s = suggestions[0];
    expect(s.ticket).toBe("GP-100");
    expect(s.name).toBe("New theme tu_lov_uk_19 split test");
    expect(s.themeSlug).toBe("tu_lov_uk_19");
    expect(s.promote).toEqual({
      business: "Top Up",
      name: "New theme tu_lov_uk_19 split test",
      ticket: "GP-100",
      theme: "tu_lov_uk_19",
    });
    expect(s.alreadyPromoted).toBe(false);
    expect(s.buildTicket).toBeNull();
  });

  it("omits the theme param when the ticket carries no slug", async () => {
    mockBacklog.mockResolvedValue(
      backlog([ticket({ id: "GP-101", summary: "TU - split test the hero", description: "" })]),
    );
    const { suggestions } = await getExperimentSuggestions();
    expect(suggestions[0].themeSlug).toBeNull();
    expect(suggestions[0].promote).not.toHaveProperty("theme");
  });
});

describe("getExperimentSuggestions — dedupe already-promoted", () => {
  it("flags a ticket that already has a live experiment (bare id AND full URL)", async () => {
    mockBacklog.mockResolvedValue(
      backlog([ticket({ id: "GP-1" }), ticket({ id: "GP-2" }), ticket({ id: "GP-3" })]),
    );
    // GP-1 referenced by bare id, GP-2 by a full issue URL, GP-3 not referenced.
    mockListExperiments.mockResolvedValue([
      { youtrackTicket: "GP-1" },
      { youtrackTicket: "https://sanjow.youtrack.cloud/issue/GP-2" },
    ] as never);

    const { suggestions } = await getExperimentSuggestions();
    const byId = Object.fromEntries(suggestions.map((s) => [s.ticket, s.alreadyPromoted]));
    expect(byId["GP-1"]).toBe(true);
    expect(byId["GP-2"]).toBe(true);
    expect(byId["GP-3"]).toBe(false);
  });
});

describe("getExperimentSuggestions — ledger dedupe", () => {
  it("attaches an existing build ticket keyed on (source ticket, theme slug)", async () => {
    mockBacklog.mockResolvedValue(
      backlog([
        ticket({ id: "GP-2", summary: "TU - split", description: "theme=tu_lov_uk_19" }),
      ]),
    );
    mockListBuildTickets.mockResolvedValue([
      {
        id: "row-1",
        sourceTicket: "GP-2",
        themeSlug: "tu_lov_uk_19",
        business: "Top Up",
        project: "GP",
        summary: "…",
        createdTicket: "GP-742",
        status: "created",
        createdBy: null,
        createdAtMs: 0,
      },
    ]);

    const { suggestions } = await getExperimentSuggestions();
    expect(suggestions[0].buildTicket?.createdTicket).toBe("GP-742");
  });
});

describe("getExperimentSuggestions — graceful degradation", () => {
  it("still returns suggestions when the experiments read throws (nothing flagged promoted)", async () => {
    mockBacklog.mockResolvedValue(backlog([ticket({ id: "GP-9" })]));
    mockListExperiments.mockRejectedValue(new Error("Neon down"));
    mockListBuildTickets.mockRejectedValue(new Error("Neon down"));

    const { suggestions } = await getExperimentSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].alreadyPromoted).toBe(false);
    expect(suggestions[0].buildTicket).toBeNull();
  });
});

describe("extractTicketId", () => {
  it("pulls the readable id from a bare id or a full URL, upper-cased", () => {
    expect(extractTicketId("GP-742")).toBe("GP-742");
    expect(extractTicketId("https://sanjow.youtrack.cloud/issue/gp-603")).toBe("GP-603");
    expect(extractTicketId("")).toBeNull();
    expect(extractTicketId("no id here")).toBeNull();
  });
});
