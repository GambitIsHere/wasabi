// ============================================================================
// build-ticket-payload.ts — the pure payload builder. No I/O, tested directly.
// Covers both house routes (front-end GP / back-end business), the spine shape,
// the no-assignee invariant, and the summary cap.
// ============================================================================
import { describe, expect, it } from "vitest";
import { buildBuildTicketPayload } from "@/lib/build-ticket-payload";

const ctx = {
  sourceTicket: "GP-573",
  business: "Top Up",
  experimentName: "Billing test 39 + 19 UK",
  themeSlug: "tu_promo_marquee",
  repo: "prepaid-mobile-recharge-ai",
  readinessReason: 'Not built — "tu_promo_marquee" has an unrecognised segment.',
};

describe("buildBuildTicketPayload — front-end (default GP route)", () => {
  const p = buildBuildTicketPayload(ctx);

  it("routes to GP", () => {
    expect(p.projectShortName).toBe("GP");
  });

  it("sets Kanban State BACKLOG and PRODUCT = the business, with Ticket Type Feature", () => {
    const byName = Object.fromEntries(p.customFields.map((f) => [f.name, f]));
    expect(byName["Kanban State"].value).toEqual({ name: "BACKLOG" });
    expect(byName["PRODUCT"].value).toEqual({ name: "Top Up" });
    expect(byName["Ticket Type"].value).toEqual({ name: "Feature" });
  });

  it("NEVER sets an assignee (Unassigned by default)", () => {
    expect(p.customFields.some((f) => f.name === "Assignee")).toBe(false);
  });

  it("prefixes the summary with the business code and names the arm", () => {
    expect(p.summary.startsWith("TU | ")).toBe(true);
    expect(p.summary).toContain("tu_promo_marquee");
  });

  it("builds a spine-shaped body — type H1, In short line, AC checkboxes, QA prose", () => {
    expect(p.description).toContain("# Feature");
    expect(p.description).toContain("In short, build the \"tu_promo_marquee\"");
    expect(p.description).toContain("# Acceptance Criteria");
    expect(p.description).toContain("- [ ]");
    expect(p.description).toContain("## QA Testing");
    expect(p.description).toContain("GP-573");
  });

  it("keeps the three-blank-line spine spacing between blocks", () => {
    expect(p.description).toContain("\n\n\n\n");
  });

  it("tags the ticket 'experiment' so the clean tag-source query later picks it up", () => {
    expect(p.tags).toEqual(["experiment"]);
  });
});

describe("buildBuildTicketPayload — back-end route", () => {
  it("routes to the business's own project with Dev Status BACKLOG and TEAM ALPHA7", () => {
    const p = buildBuildTicketPayload({ ...ctx, route: "backend" });
    expect(p.projectShortName).toBe("TU");
    const byName = Object.fromEntries(p.customFields.map((f) => [f.name, f]));
    expect(byName["Dev Status"].value).toEqual({ name: "BACKLOG" });
    expect(byName["TEAM"].value).toEqual({ name: "ALPHA7" });
  });

  it("maps Global Visa to its back-end project OV (not the front-end GV code)", () => {
    const p = buildBuildTicketPayload({ ...ctx, business: "Global Visa", route: "backend" });
    expect(p.projectShortName).toBe("OV");
  });
});

describe("buildBuildTicketPayload — summary cap", () => {
  it("caps the summary at 250 characters", () => {
    const p = buildBuildTicketPayload({
      ...ctx,
      experimentName: "x".repeat(400),
    });
    expect(p.summary.length).toBe(250);
  });
});
