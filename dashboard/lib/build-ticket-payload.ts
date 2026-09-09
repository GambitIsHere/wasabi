// ============================================================================
// Build-ticket payload — turn a NOT-BUILT experiment arm into a YouTrack issue
// body + fields (pure; no I/O, so it's unit-tested directly).
// ----------------------------------------------------------------------------
// The roadmap→YouTrack loop offers a "create build ticket" action only when an
// arm is NOT-BUILT (see lib/variant-readiness.ts). This module builds exactly
// what POST /api/issues needs — project shortName, summary, spine-shaped body,
// custom fields, tags — and NOTHING it doesn't: no assignee (a build ticket
// defaults to Unassigned), no priority/severity/sprint.
//
// ROUTING follows the house rules (CLAUDE.md's ticket template):
//   * front-end theme work → GP, with Kanban State BACKLOG and PRODUCT = the
//     business. Variant/arm work lives in the storefront front-end, so this loop
//     always uses this route.
//   * back-end work → the business's own project, with Dev Status BACKLOG and
//     TEAM ALPHA7. Implemented + tested here for completeness, but this loop's UI
//     never selects it (a variant build is front-end).
//
// The custom-field $type strings are YouTrack's field types. They must match how
// each field is defined in the target project; they are collected here so a
// first-enablement mismatch is a one-line fix, and flagged in the PR because the
// write path can't be exercised against the live instance from this build.
// ============================================================================
import type { IssueCustomField } from "./youtrack-write";
import { businessCode } from "./mgmt";

export type BuildRoute = "frontend" | "backend";

export interface BuildTicketContext {
  /** The backlog ticket that seeded the suggestion, e.g. "GP-573". */
  sourceTicket: string;
  business: string;
  /** The suggested experiment name (what the arm is for). */
  experimentName: string;
  /** The arm's theme slug (or &var= value) that isn't built yet. */
  themeSlug: string;
  /** The storefront repo the readiness check looked at (for the body). */
  repo?: string;
  /** The readiness reason string (why it's considered not built). */
  readinessReason?: string;
  route?: BuildRoute;
}

export interface BuildTicketPayload {
  /** Project shortName ("GP" or the business's own project). */
  projectShortName: string;
  summary: string;
  description: string;
  customFields: IssueCustomField[];
  tags: string[];
}

// YouTrack custom-field $types (see module header).
const STATE_FIELD = "StateIssueCustomField";
const ENUM_FIELD = "SingleEnumIssueCustomField";

// business label → the business's own back-end project shortName. Aligned to the
// house-rules table (Global Visa's back-end project is OV, not the GV code the
// front-end select uses). Only consulted on the back-end route.
const BUSINESS_BACKEND_PROJECT: Record<string, string> = {
  "Top Up": "TU",
  "Airport Check-In": "AC",
  "Airport Security": "AS",
  "PDF SaaS": "PDF",
  "Global Tickets": "GT",
  "Global Visa": "OV",
  "Gift Cards": "GC",
  "Airport Lounges": "AL",
};

/** Three blank lines between blocks — the house spine's load-bearing spacing. */
const GAP = "\n\n\n\n";

function buildDescription(ctx: BuildTicketContext): string {
  const repoPhrase = ctx.repo ? ` in the ${ctx.repo} storefront` : "";
  const reason = ctx.readinessReason
    ? ` ${ctx.readinessReason}`
    : "";
  const context =
    `# Feature\n\n` +
    `The roadmap promoted ${ctx.sourceTicket} into the experiment "${ctx.experimentName}" for ${ctx.business}. ` +
    `One arm routes to the theme slug "${ctx.themeSlug}", which is not built yet${repoPhrase}.${reason} ` +
    `The experiment cannot run this arm until the storefront serves it.`;

  const inShort =
    `In short, build the "${ctx.themeSlug}" variant so the ${ctx.sourceTicket} experiment can run all arms.`;

  const ac =
    `# Acceptance Criteria\n\n` +
    `- [ ] The storefront serves the "${ctx.themeSlug}" arm end to end.\n` +
    `- [ ] Tests cover the new arm.\n` +
    `- [ ] The control arm and the existing themes stay unchanged.`;

  const qa =
    `## QA Testing\n\n` +
    `Full flow on the ${ctx.business} storefront — check the "${ctx.themeSlug}" arm renders and the control is untouched, then confirm the other brands are unchanged.`;

  return [context, inShort, ac, qa].join(GAP);
}

/**
 * Build the create-issue payload for a NOT-BUILT arm. Pure — the caller resolves
 * the projectShortName to an internal id and POSTs it. Never sets an assignee.
 */
export function buildBuildTicketPayload(
  ctx: BuildTicketContext,
): BuildTicketPayload {
  const route: BuildRoute = ctx.route ?? "frontend";
  const code = businessCode(ctx.business);
  const summary = `${code} | Build variant ${ctx.themeSlug} for ${ctx.experimentName}`.slice(0, 250);
  const description = buildDescription(ctx);
  const tags = ["experiment"];

  if (route === "backend") {
    const projectShortName = BUSINESS_BACKEND_PROJECT[ctx.business] ?? code;
    return {
      projectShortName,
      summary,
      description,
      customFields: [
        { name: "Dev Status", $type: STATE_FIELD, value: { name: "BACKLOG" } },
        { name: "TEAM", $type: ENUM_FIELD, value: { name: "ALPHA7" } },
        { name: "Ticket Type", $type: ENUM_FIELD, value: { name: "Feature" } },
      ],
      tags,
    };
  }

  // front-end (default): GP, Kanban State BACKLOG, PRODUCT = business.
  return {
    projectShortName: "GP",
    summary,
    description,
    customFields: [
      { name: "Kanban State", $type: STATE_FIELD, value: { name: "BACKLOG" } },
      { name: "PRODUCT", $type: ENUM_FIELD, value: { name: ctx.business } },
      { name: "Ticket Type", $type: ENUM_FIELD, value: { name: "Feature" } },
    ],
    tags,
  };
}
