// Small presentational pills shared across the dashboard. Server-safe (no client
// hooks) so they render in server components without a "use client" boundary.
// Optimiser.Pro: mono uppercase labels, token-driven colours.
import type { Recommendation } from "@/lib/verdict";

/** Active / paused status pill for an experiment. */
export function StatusPill({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-good/30 bg-good/10 px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-good">
      <span className="size-1.5 rounded-full bg-good" aria-hidden="true" />
      Active
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-muted">
      <span className="size-1.5 rounded-full bg-faint" aria-hidden="true" />
      Paused
    </span>
  );
}

/** Small "control" tag for the baseline arm. */
export function ControlBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-info/30 bg-info/10 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-info">
      control
    </span>
  );
}

const REC_STYLES: Record<
  Recommendation,
  { label: string; className: string }
> = {
  ship: {
    label: "Ship",
    className: "border-good/40 bg-good/10 text-good",
  },
  keep_running: {
    label: "Keep running",
    className: "border-warn/40 bg-warn/10 text-warn",
  },
  inconclusive: {
    label: "Inconclusive",
    className: "border-line-strong bg-surface text-muted",
  },
};

/** The headline verdict pill (ship / keep running / inconclusive). */
export function VerdictPill({
  recommendation,
}: {
  recommendation: Recommendation;
}) {
  const { label, className } = REC_STYLES[recommendation];
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1 font-mono text-xs font-semibold uppercase tracking-wider ${className}`}
    >
      <span className="size-2 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}
