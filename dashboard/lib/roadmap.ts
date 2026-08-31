// ============================================================================
// Test roadmap — the committed A/B run order, per product lane.
// ----------------------------------------------------------------------------
// Curated on purpose (NOT the live YouTrack backlog): the tests we've agreed to
// run, in sequence, across lanes that run in parallel. Lanes never interfere
// (different sites/traffic); inside a lane, one test at a time — ship the
// winner, start the next. On VWO now; GP-549 doubles as the Wasabi pilot.
// Weeks are relative (W1 = kickoff). Edit this list to re-plan.
// ============================================================================

export type Lane = "AC" | "AS" | "TU" | "PDF";
export type TestStatus = "live" | "prod-review" | "built" | "pending";

export interface RoadmapTest {
  ticket: string; // GP-xxx, or "" when a ticket is still being drafted
  title: string;
  surface: string;
  startWeek: number; // 1-indexed, inclusive
  endWeek: number; // inclusive
  status: TestStatus;
  pilot?: boolean; // doubles as the Wasabi pilot
  note?: string; // small caption (re-run origin, "new ticket", …)
  rerunOf?: string; // archive VWO campaign sourceId this test re-runs (see lib/tested-elements.ts)
}

export interface RoadmapLane {
  lane: Lane;
  business: string;
  repo: string;
  site: string;
  tests: RoadmapTest[];
}

export const TOTAL_WEEKS = 10;

export const ROADMAP: RoadmapLane[] = [
  {
    lane: "AC",
    business: "Airport Check-In",
    repo: "checkin-ai",
    site: "checkin.my-trip-online.com",
    tests: [
      { ticket: "GP-502", title: "Ask for one passport number on the landing form", surface: "Landing form", startWeek: 1, endWeek: 2, status: "built" },
      { ticket: "GP-504", title: "Make the phone number mandatory before payment", surface: "Pre-payment form", startWeek: 3, endWeek: 4, status: "built" },
      { ticket: "GP-549", title: "Trustpilot carousel below payment", surface: "Payment page", startWeek: 5, endWeek: 6, status: "built", pilot: true },
      { ticket: "GP-124", title: "Nylas “connect your inbox” — re-run", surface: "Landing + passengers", startWeek: 7, endWeek: 9, status: "built", note: "Re-runs the GP-69 painted door in a live placement", rerunOf: "369" },
    ],
  },
  {
    lane: "AS",
    business: "Airport Security",
    repo: "fast-track-ai",
    site: "Exec Pass landing",
    tests: [
      { ticket: "GP-452", title: "Invert the hero colours", surface: "Landing hero", startWeek: 1, endWeek: 6, status: "live", note: "Traffic-starved — VWO put it at 369 days to significance; Exec Pass UK can't settle a ~7% effect at this volume. Needs a larger MDE or a higher-traffic property. The lane waits on it.", rerunOf: "364" },
      { ticket: "GP-564", title: 'Add a "flight number" field on the landing', surface: "Landing form", startWeek: 7, endWeek: 8, status: "prod-review", note: "Blocked behind GP-452" },
      { ticket: "GP-565", title: "Ask departure vs arrival (dual-Fast-Track airports)", surface: "Landing form · airport subset", startWeek: 9, endWeek: 10, status: "built", note: "Airport subset — long pole; waits on GP-452" },
    ],
  },
  {
    lane: "TU",
    business: "Top Up",
    repo: "prepaid-mobile-recharge-ai",
    site: "recharge landing",
    tests: [
      { ticket: "GP-603", title: "Reassurance banner — fresh design + new USPs", surface: "Header banner", startWeek: 1, endWeek: 3, status: "pending", note: "Re-run of GP-303 (dead goal, 0 conversions) — GP-603 in S16", rerunOf: "362" },
    ],
  },
  {
    lane: "PDF",
    business: "PDF SaaS",
    repo: "pdf",
    site: "we-pdf.com · EX17 landing",
    tests: [
      { ticket: "GP-600", title: "EX17 v2 vs current — split URL", surface: "we-pdf.com landing", startWeek: 1, endWeek: 4, status: "pending", note: "Two URLs on the pdf repo: control = the existing EX17, variant = EX17_v2 replicated from the pdf-ai repo" },
    ],
  },
];

export const YT = (ticket: string): string =>
  `https://sanjow.youtrack.cloud/issue/${ticket}`;
