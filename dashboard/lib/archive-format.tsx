// ============================================================================
// Wasabi — archive presentation helpers, shared by the list page
// (app/archive/page.tsx) and the detail page (app/archive/[key]/page.tsx).
// Kept here so the STATUS mapping, date formatting and the <Uplift/> pill are
// defined once and render identically on both.
// ============================================================================
import type { ArchivedExperiment, ArchivedStatus } from "@/lib/archive";

/** Status → label + Tailwind pill classes. Same mapping on both archive pages. */
export const STATUS: Record<ArchivedStatus, { label: string; cls: string }> = {
  winner: { label: "Winner", cls: "border-good/30 bg-good/10 text-good" },
  lost: { label: "Lost", cls: "border-bad/30 bg-bad/10 text-bad" },
  inconclusive: {
    label: "Inconclusive",
    cls: "border-warn/30 bg-warn/10 text-warn",
  },
  archived: { label: "Archived", cls: "border-line-strong bg-bg text-muted" },
};

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/** "YYYY-MM-DD" → "Mon D, YYYY". No timezone parsing — regex the parts. */
export function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

/** Start – end range, or a single date, or "date n/a". */
export function dateRange(exp: ArchivedExperiment): string {
  const s = fmtDate(exp.startDate);
  const e = fmtDate(exp.endDate);
  if (s && e) return `${s} – ${e}`;
  return s ?? e ?? "date n/a";
}

/** Integer with US grouping. */
export const int = (n: number) => n.toLocaleString("en-US");

/** Uplift pill: null → "—", ~0 → "0%", positive → green "▲ +X.X%", negative → red "▼ X.X%". */
export function Uplift({ value }: { value: number | null }) {
  if (value == null) return <span className="text-faint">—</span>;
  if (Math.abs(value) < 0.05)
    return <span className="tabular-nums text-muted">0%</span>;
  const good = value > 0;
  return (
    <span
      className={`tabular-nums font-medium ${good ? "text-good" : "text-bad"}`}
    >
      {good ? "▲" : "▼"} {good ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}
