// ============================================================================
// Wasabi — roadmap presentation helpers, shared by the roadmap timeline
// (app/roadmap/page.tsx) and the per-test detail page
// (app/roadmap/[ticket]/page.tsx). The lane-colour and status-pill mappings live
// here so a lane reads the same colour and a status the same pill on the runway,
// the per-lane list and the test detail. Mirrors lib/archive-format.
// ============================================================================
import type { Lane, TestStatus } from "@/lib/roadmap";

/** Lane → Cockpit colour tokens (text · bar fill · swatch). One colour per lane. */
export const LANE: Record<Lane, { text: string; bar: string; sw: string }> = {
  AC: { text: "text-info", bar: "border-info/40 bg-info/10", sw: "bg-info" },
  AS: { text: "text-amber", bar: "border-amber/40 bg-amber/10", sw: "bg-amber" },
  TU: { text: "text-sky", bar: "border-sky/40 bg-sky/10", sw: "bg-sky" },
  PDF: {
    text: "text-violet",
    bar: "border-violet/40 bg-violet/10",
    sw: "bg-violet",
  },
};

/** Test status → label + pill classes. Same mapping on the runway and the detail page. */
export const STATUS: Record<TestStatus, { label: string; cls: string }> = {
  live: { label: "Live now", cls: "border-good/30 bg-good/10 text-good" },
  "prod-review": {
    label: "Prod review",
    cls: "border-warn/30 bg-warn/10 text-warn",
  },
  built: { label: "Built", cls: "border-line-strong bg-bg text-muted" },
  pending: {
    label: "New ticket",
    cls: "border-violet/30 bg-violet/10 text-violet",
  },
};
