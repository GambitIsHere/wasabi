// ============================================================================
// Cockpit homepage — shared view-models.
// ----------------------------------------------------------------------------
// PURE types (no "use client", no I/O). The server page (app/page.tsx) builds
// these flat, serialisable shapes and hands them to the client ExperimentTable,
// so the table can filter/search over already-decided data without re-reading
// the DB or Metabase. Every payment/verdict field is nullable — it is populated
// only when Metabase is reachable (prod); locally it stays null and the table
// renders a clean "—".
// ============================================================================
import type { Recommendation } from "@/lib/verdict";

/** One arm of the traffic split — always available (experiment config). */
export interface TrafficSplitArm {
  key: string;
  pct: number;
  isControl: boolean;
}

/** A guardrail breach surfaced from the verdict (significant negative auth move). */
export interface GuardrailFlag {
  experimentKey: string;
  arm: string;
  /** Human line, e.g. "auth_rate 51.2% vs control 58.9% (−7.7pp, 99% confident)". */
  detail: string;
}

/**
 * One table row, fully decided on the server. Config fields (name, split, dates,
 * todayCount) are always present; verdict/money fields are null unless Metabase
 * returned a cohort for this experiment.
 */
export interface ExperimentRowVM {
  key: string;
  name: string;
  business: string;
  active: boolean;
  startDate: string;
  daysRunning: number;
  /** Assignments captured for this experiment today (UTC). */
  todayCount: number;

  // --- traffic split (config) ---
  split: TrafficSplitArm[];
  controlKey: string;

  // --- verdict + money (Metabase-only; null locally) ---
  verdictAvailable: boolean;
  recommendation: Recommendation | null;
  /** Faint one-liner under the verdict pill (e.g. "control · £4.20/acq"). */
  verdictSubline: string | null;
  /** Challenger's £/acquired (GBP). */
  moneyValue: number | null;
  /** Control's £/acquired (GBP). */
  moneyControl: number | null;
  /** moneyValue − moneyControl (GBP). */
  moneyDeltaAbs: number | null;
  /** Relative delta vs control (e.g. −0.21 = −21%). */
  moneyDeltaRel: number | null;
}
