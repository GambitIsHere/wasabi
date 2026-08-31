"use client";

// Cockpit verdict table — the heart of the homepage. A client island so search +
// the business/status filters run instantly over data that was fully decided on
// the server (verdicts + £/acquired come pre-computed in each ExperimentRowVM;
// this component never re-reads the DB or Metabase). One <tr> per experiment; the
// row navigates to the detail page, with the experiment name as the real,
// keyboard-focusable link. Payment/verdict columns render "—" when Metabase was
// unavailable (locally), so the table is correct with or without it.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Recommendation } from "@/lib/verdict";
import type { ExperimentRowVM, TrafficSplitArm } from "./types";

type StatusFilter = "all" | "active" | "paused";

// The cockpit is live: COLLECTED TODAY, the feed and today's counts all move as
// captures/payments land, so we pull fresh server data on this cadence.
const LIVE_REFRESH_MS = 5000;

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

type Tone = "good" | "warn" | "info" | "faint";

const TONE_PILL: Record<Tone, string> = {
  good: "border-good/40 bg-good/10 text-good",
  warn: "border-warn/40 bg-warn/10 text-warn",
  info: "border-info/40 bg-info/10 text-info",
  faint: "border-line-strong bg-surface text-muted",
};

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${TONE_PILL[tone]}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  );
}

const REC_LABEL: Record<Recommendation, { label: string; tone: Tone }> = {
  ship: { label: "Ship", tone: "good" },
  keep_running: { label: "Keep running", tone: "warn" },
  inconclusive: { label: "Inconclusive", tone: "faint" },
};

function gbp(n: number): string {
  return `£${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** House convention: colour = outcome, arrow = direction. Higher £/acq is good. */
function MetricDelta({ abs, rel }: { abs: number; rel: number }) {
  const up = abs >= 0;
  const arrow = up ? "↑" : "↓";
  const cls = up ? "text-good" : "text-bad";
  const sign = up ? "+" : "−";
  const pct = `${up ? "+" : "−"}${Math.abs(Math.round(rel * 100))}%`;
  return (
    <span className={`font-mono text-[11px] tabular-nums ${cls}`}>
      {arrow} {sign}£{Math.abs(abs).toFixed(2)} ({pct})
    </span>
  );
}

// Split-bar palette — control green, challengers cycle through the cockpit hues.
const VARIANT_BAR = ["bg-info", "bg-violet", "bg-amber", "bg-pink", "bg-sky"];

function SplitBar({ split }: { split: TrafficSplitArm[] }) {
  let vi = 0;
  return (
    <div className="flex h-2 w-full min-w-[7rem] overflow-hidden rounded-full bg-bg">
      {split.map((arm) => {
        const color = arm.isControl
          ? "bg-accent"
          : VARIANT_BAR[vi++ % VARIANT_BAR.length];
        return (
          <div
            key={arm.key}
            className={color}
            style={{ width: `${arm.pct}%` }}
            title={`${arm.key}: ${arm.pct}%`}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cells that branch on data availability
// ---------------------------------------------------------------------------

function VerdictCell({ row }: { row: ExperimentRowVM }) {
  if (row.verdictAvailable && row.recommendation) {
    const { label, tone } = REC_LABEL[row.recommendation];
    return (
      <div className="space-y-1">
        <Pill tone={tone}>{label}</Pill>
        {row.verdictSubline && (
          <p className="font-mono text-[11px] text-faint">{row.verdictSubline}</p>
        )}
      </div>
    );
  }
  if (!row.active) {
    return (
      <div className="space-y-1">
        <Pill tone="faint">Queued</Pill>
        <p className="font-mono text-[11px] text-faint">seeded paused</p>
      </div>
    );
  }
  if (row.todayCount === 0) {
    return (
      <div className="space-y-1">
        <Pill tone="warn">No traffic</Pill>
        <p className="font-mono text-[11px] text-faint">awaiting middleware</p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <span className="font-mono text-sm text-faint">—</span>
      <p className="font-mono text-[11px] text-faint">no data</p>
    </div>
  );
}

function MoneyCell({ row }: { row: ExperimentRowVM }) {
  if (
    row.moneyValue == null ||
    row.moneyControl == null ||
    row.moneyDeltaAbs == null ||
    row.moneyDeltaRel == null
  ) {
    return <span className="font-mono text-sm text-faint">—</span>;
  }
  return (
    <div className="space-y-0.5">
      <p className="font-mono text-base font-semibold tabular-nums text-fg">
        {gbp(row.moneyValue)}
      </p>
      <p className="font-mono text-[11px] text-faint">
        vs {gbp(row.moneyControl)}
      </p>
      <MetricDelta abs={row.moneyDeltaAbs} rel={row.moneyDeltaRel} />
    </div>
  );
}

function TodayCell({ row }: { row: ExperimentRowVM }) {
  if (!row.active) {
    return (
      <div>
        <span className="font-mono text-sm text-faint">queued</span>
        <p className="font-mono text-[11px] text-faint">paused</p>
      </div>
    );
  }
  const zero = row.todayCount === 0;
  return (
    <div>
      <span
        className={`font-mono text-sm font-semibold tabular-nums ${
          zero ? "text-warn" : "text-fg"
        }`}
      >
        {zero ? "0" : `+${row.todayCount}`}
      </span>
      <p className="font-mono text-[11px] text-faint">
        {row.daysRunning}d · since {row.startDate}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function ExperimentTable({
  rows,
  businesses,
}: {
  rows: ExperimentRowVM[];
  businesses: string[];
}) {
  const router = useRouter();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [business, setBusiness] = useState("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const controlsRef = useRef<HTMLDivElement>(null);

  // Live refresh. router.refresh() re-runs the server component and merges the
  // fresh RSC payload into THIS already-mounted island — the search/business/
  // status state above and input focus survive it, because nothing here remounts
  // and none of that state is lifted to the server. The one moment a merge would
  // hurt is mid-keystroke: it can reflow the filtered rows under the cursor and,
  // during the merge, steal focus from the search box — the dropped-keystroke bug.
  // So a tick is skipped whenever focus is inside the search/filter controls; the
  // poll resumes the moment the operator clicks away, and catches up then.
  useEffect(() => {
    const id = setInterval(() => {
      if (controlsRef.current?.contains(document.activeElement)) return;
      router.refresh();
    }, LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [router]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (business !== "all" && r.business !== business) return false;
      if (status === "active" && !r.active) return false;
      if (status === "paused" && r.active) return false;
      if (q) {
        const hay = `${r.name} ${r.key} ${r.business}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, query, business, status]);

  const selectCls =
    "rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg outline-none transition-colors hover:border-line-strong focus-visible:border-accent";

  return (
    <section aria-label="Experiments" className="space-y-3">
      {/* Search + filters */}
      <div
        ref={controlsRef}
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
      >
        <div className="relative flex-1">
          <label htmlFor={searchId} className="sr-only">
            Search experiments
          </label>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-faint"
          >
            ⌕
          </span>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search experiments, keys, slugs…"
            className="w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm text-fg placeholder:text-faint outline-none transition-colors hover:border-line-strong focus-visible:border-accent"
          />
        </div>
        <label className="sr-only" htmlFor={`${searchId}-biz`}>
          Filter by business
        </label>
        <select
          id={`${searchId}-biz`}
          value={business}
          onChange={(e) => setBusiness(e.target.value)}
          className={selectCls}
        >
          <option value="all">All businesses</option>
          {businesses.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor={`${searchId}-status`}>
          Filter by status
        </label>
        <select
          id={`${searchId}-status`}
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          className={selectCls}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[840px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-line font-mono text-[11px] uppercase tracking-wider text-muted">
              <th scope="col" className="px-4 py-3 font-medium">
                Experiment
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                <span title="Ship / keep running / inconclusive, from the payment-P&L verdict">
                  Verdict
                </span>
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                <span title="Challenger £ per acquired customer vs control">
                  £ / Acquired
                </span>
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Traffic split
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Trend
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Today
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-10 text-center text-sm text-faint"
                >
                  No experiments match your filters.
                </td>
              </tr>
            ) : (
              filtered.map((row) => (
                <tr
                  key={row.key}
                  className="row-clickable cursor-pointer align-top"
                  onClick={(e) => {
                    // Let a click that landed on the real link navigate itself.
                    if ((e.target as HTMLElement).closest("a")) return;
                    router.push(`/experiments/${row.key}`);
                  }}
                >
                  {/* Experiment */}
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2">
                      <span
                        aria-hidden="true"
                        className={`mt-1.5 size-2 shrink-0 rounded-full ${
                          row.active ? "bg-good" : "bg-faint"
                        }`}
                      />
                      <div className="min-w-0">
                        <Link
                          href={`/experiments/${row.key}`}
                          className="block truncate font-medium text-fg outline-none transition-colors hover:text-accent focus-visible:text-accent"
                        >
                          {row.name}
                        </Link>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-faint">
                          {row.key} · {row.business}
                        </p>
                      </div>
                    </div>
                  </td>
                  {/* Verdict */}
                  <td className="px-4 py-3">
                    <VerdictCell row={row} />
                  </td>
                  {/* £ / acquired */}
                  <td className="px-4 py-3">
                    <MoneyCell row={row} />
                  </td>
                  {/* Traffic split */}
                  <td className="px-4 py-3">
                    <div className="space-y-1.5">
                      <SplitBar split={row.split} />
                      <p className="font-mono text-[11px] text-faint">
                        {row.split
                          .map((a) => `${a.key} ${a.pct}%`)
                          .join(" · ")}
                      </p>
                    </div>
                  </td>
                  {/* Trend */}
                  <td className="px-4 py-3">
                    <span
                      className="font-mono text-sm text-faint"
                      title="No trend series available yet"
                    >
                      —
                    </span>
                  </td>
                  {/* Today */}
                  <td className="px-4 py-3 text-right">
                    <TodayCell row={row} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
