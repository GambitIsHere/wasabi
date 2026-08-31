// ============================================================================
// Tested-elements registry — closes the loop between /archive and /roadmap.
// ----------------------------------------------------------------------------
// Two questions this answers, from one source of truth:
//   1. "Don't re-test a settled lever" — every lever we've already put in front
//      of traffic, with a verdict (settled-negative / inconclusive-retest /
//      broken-rerun / unread) and the one-line takeaway.
//   2. "Which past runs feed a re-test" — the map from an archived campaign to a
//      roadmap re-run: already scheduled (derived from ROADMAP.rerunOf) or a
//      fresh candidate not yet on the plan.
//
// Everything keys off the stable VWO campaign sourceId. This module is PURE
// (no DB import), so it stays client-safe; a page resolves a sourceId to its
// archive `key` at render time via listArchived() when it needs a deep link.
// ============================================================================
import { ROADMAP, type Lane, type RoadmapTest } from "./roadmap";

// ---------------------------------------------------------------------------
// Verdicts — a lever's standing, and what the UI should say about it.
// ---------------------------------------------------------------------------

export type Verdict =
  | "settled-negative" // tested, lost or settled no-effect — do NOT re-test
  | "inconclusive-retest" // didn't settle — worth one clean re-run
  | "broken-rerun" // dead goal or traffic-starved — re-run to actually learn
  | "unread"; // captured, not yet read against Wasabi's auth+rebill+LTV cut

export const VERDICTS: readonly Verdict[] = [
  "settled-negative",
  "inconclusive-retest",
  "broken-rerun",
  "unread",
] as const;

export interface VerdictMeta {
  label: string;
  blurb: string; // one line, for the legend
}

export const VERDICT_META: Record<Verdict, VerdictMeta> = {
  "settled-negative": {
    label: "Settled — leave it",
    blurb: "Lost or no-effect. Don't re-test.",
  },
  "inconclusive-retest": {
    label: "Inconclusive — re-test",
    blurb: "Didn't settle; worth one clean re-run.",
  },
  "broken-rerun": {
    label: "Broken — re-run",
    blurb: "Dead goal or too little traffic; re-run to learn.",
  },
  unread: {
    label: "Unread",
    blurb: "Captured, not yet analysed on the Wasabi cut.",
  },
};

// ---------------------------------------------------------------------------
// The registry — one row per lever we've already tested.
// ---------------------------------------------------------------------------

export interface TestedElement {
  id: string; // stable slug
  lever: string; // human name
  business: string; // owning business
  lane: Lane | null; // roadmap lane, or null when the business has no lane yet
  verdict: Verdict;
  sourceIds: string[]; // archive VWO campaign ids behind the verdict
  takeaway: string; // one line — what the verdict means for the plan
}

export const TESTED_ELEMENTS: TestedElement[] = [
  {
    id: "trustpilot-widgets",
    lever: "Trustpilot social-proof widgets",
    business: "Airport Check-In",
    lane: "AC",
    verdict: "settled-negative",
    sourceIds: ["318", "319"],
    takeaway:
      "Homepage (318) and checkout (319) both moved nothing — social proof is settled no-effect on Check-In.",
  },
  {
    id: "checkout-phone-field",
    lever: "Checkout phone-number field",
    business: "PDF SaaS",
    lane: null,
    verdict: "settled-negative",
    sourceIds: ["329"],
    takeaway: "Adding a phone field to PDF checkout lost. Drop it, don't reintroduce.",
  },
  {
    id: "airline-logo",
    lever: "Airline logo on the landing",
    business: "Airport Check-In",
    lane: "AC",
    verdict: "settled-negative",
    sourceIds: ["349"],
    takeaway: "Removing the airline logo lost (349). Keep the logo.",
  },
  {
    id: "nylas-prepayment",
    lever: "Nylas “connect your inbox”, pre-payment",
    business: "Airport Check-In",
    lane: "AC",
    verdict: "settled-negative",
    sourceIds: ["357"],
    takeaway:
      "Pre-payment Nylas placement lost (357). Only the painted-door demand (369) is worth re-running — GP-124 does, in a new placement.",
  },
  {
    id: "checkout-wording-stardoc",
    lever: "Checkout wording (Stardoc)",
    business: "PDF SaaS",
    lane: null,
    verdict: "inconclusive-retest",
    sourceIds: ["292"],
    takeaway:
      "Stardoc V3 wording came back inconclusive — the most promising re-run in the set.",
  },
  {
    id: "per-airline-bg-cta",
    lever: "Per-airline background + CTA",
    business: "Airport Check-In",
    lane: "AC",
    verdict: "inconclusive-retest",
    sourceIds: ["338"],
    takeaway:
      "Per-airline variants fragmented traffic and never settled. Merge into one all-airlines test (338).",
  },
  {
    id: "exec-pass-hero-colour",
    lever: "Exec Pass hero colour",
    business: "Airport Security",
    lane: "AS",
    verdict: "broken-rerun",
    sourceIds: ["364"],
    takeaway:
      "Hero inverse (364) never reached significance — traffic-starved, not a null. GP-452 re-runs it with a larger MDE.",
  },
  {
    id: "tu-usp-banner",
    lever: "Reassurance / USP header banner",
    business: "Top Up",
    lane: "TU",
    verdict: "broken-rerun",
    sourceIds: ["362"],
    takeaway:
      "GP-303 ran on a dead goal (V1 lost, V2 tied on a broken metric). Re-run with a fresh design + new USPs.",
  },
  {
    id: "tu-billing-sku",
    lever: "Billing SKU / price",
    business: "Top Up",
    lane: "TU",
    verdict: "unread",
    sourceIds: ["323", "324"],
    takeaway:
      "TU billing 39/49 (RO 323, DE 324) captured but not yet read against auth + rebill + LTV — Wasabi's job.",
  },
];

// ---------------------------------------------------------------------------
// Re-test candidates — past runs that SHOULD feed a re-run but aren't on the
// roadmap yet. (Runs already scheduled live in ROADMAP via `rerunOf` — see
// scheduledReruns() below — so this list stays the not-yet-planned set only.)
// ---------------------------------------------------------------------------

export interface RetestCandidate {
  sourceId: string; // the past run to re-run
  elementId: string; // ties back to a TestedElement.id
  business: string;
  lane: Lane | null; // target lane, or null when the business has no lane yet
  proposedTitle: string;
  reason: string;
}

export const RETEST_CANDIDATES: RetestCandidate[] = [
  {
    sourceId: "338",
    elementId: "per-airline-bg-cta",
    business: "Airport Check-In",
    lane: "AC",
    proposedTitle: "One all-airlines BG + CTA test (retires the per-airline variants)",
    reason:
      "Per-airline splits never got the volume to conclude; a single all-airlines test does.",
  },
  {
    sourceId: "292",
    elementId: "checkout-wording-stardoc",
    business: "PDF SaaS",
    lane: null,
    proposedTitle: "Re-run Stardoc checkout wording, one cleaner variant",
    reason:
      "Most promising inconclusive in the set — worth a decisive re-run once a PDF lane opens.",
  },
];

// ---------------------------------------------------------------------------
// Derived views — read ROADMAP for the re-runs already scheduled, and combine
// with the candidates so the archive tiles can point forward from one lookup.
// ---------------------------------------------------------------------------

/** A re-run already committed on the roadmap (derived from ROADMAP.rerunOf). */
export interface ScheduledRerun {
  sourceId: string;
  lane: Lane;
  ticket: string; // "" when the ticket is still in draft
  title: string;
  status: RoadmapTest["status"];
}

/** Every roadmap test that declares a `rerunOf`, flattened across lanes. */
export function scheduledReruns(): ScheduledRerun[] {
  const out: ScheduledRerun[] = [];
  for (const lane of ROADMAP) {
    for (const t of lane.tests) {
      if (t.rerunOf) {
        out.push({
          sourceId: t.rerunOf,
          lane: lane.lane,
          ticket: t.ticket,
          title: t.title,
          status: t.status,
        });
      }
    }
  }
  return out;
}

/** How an archived run points forward: already on the plan, or a candidate. */
export type ForwardLink =
  | { kind: "scheduled"; lane: Lane; ticket: string; title: string }
  | { kind: "candidate"; lane: Lane | null; proposedTitle: string };

/**
 * sourceId → ForwardLink, for the archive tiles. Scheduled re-runs win over
 * candidates if a sourceId ever appears in both.
 */
export function forwardLinkBySourceId(): Map<string, ForwardLink> {
  const map = new Map<string, ForwardLink>();
  for (const r of scheduledReruns()) {
    map.set(r.sourceId, {
      kind: "scheduled",
      lane: r.lane,
      ticket: r.ticket,
      title: r.title,
    });
  }
  for (const c of RETEST_CANDIDATES) {
    if (!map.has(c.sourceId)) {
      map.set(c.sourceId, {
        kind: "candidate",
        lane: c.lane,
        proposedTitle: c.proposedTitle,
      });
    }
  }
  return map;
}

/** sourceId → the lever it belongs to, for legends and tooltips. */
export function testedElementBySourceId(): Map<string, TestedElement> {
  const map = new Map<string, TestedElement>();
  for (const el of TESTED_ELEMENTS) {
    for (const s of el.sourceIds) map.set(s, el);
  }
  return map;
}
