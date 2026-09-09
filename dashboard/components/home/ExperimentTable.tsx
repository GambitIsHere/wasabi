"use client";

// Cockpit verdict table — the heart of the homepage. A client island so search +
// the business/status filters run instantly over data that was fully decided on
// the server (verdicts + £/acquired come pre-computed in each ExperimentRowVM;
// this component never re-reads the DB or Metabase). One <tr> per experiment; the
// row navigates to the detail page, with the experiment name as the real,
// keyboard-focusable link. Payment/verdict columns render "—" when Metabase was
// unavailable (locally), so the table is correct with or without it.
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { bulkDeleteExperiments, bulkSetExperimentsActive } from "@/app/actions";
import { ExperimentControls } from "@/components/ExperimentControls";
import type { Recommendation } from "@/lib/verdict";
import type { ExperimentRowVM, TrafficSplitArm } from "./types";

type StatusFilter = "all" | "active" | "paused";

// The cockpit is live: COLLECTED TODAY, the feed and today's counts all move as
// captures/payments land, so we pull fresh server data on this cadence.
const LIVE_REFRESH_MS = 5000;

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

/**
 * Inline sparkline of a metric's day-over-day series (oldest→newest). Green when
 * the latest point sits at or above the first, red when below; the endpoint is
 * dotted. Fewer than 2 points renders a faint "—" (history still building). No
 * external chart library — one SVG polyline, theme-aware via --color-* tokens.
 */
function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) {
    return (
      <span
        className="font-mono text-sm text-faint"
        title="Trend builds once a couple of days of snapshots accrue"
      >
        —
      </span>
    );
  }
  const w = 68;
  const h = 22;
  const pad = 3;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (data.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const points = data
    .map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
  const up = data[data.length - 1] >= data[0];
  const stroke = up ? "var(--color-good)" : "var(--color-bad)";
  const pct =
    data[0] !== 0
      ? ((data[data.length - 1] - data[0]) / Math.abs(data[0])) * 100
      : 0;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="overflow-visible"
      role="img"
      aria-label={`£/acquired trend, ${data.length} days, ${up ? "up" : "down"} ${Math.abs(pct).toFixed(0)}%`}
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(data.length - 1)} cy={y(data[data.length - 1])} r={1.8} style={{ fill: stroke }} />
    </svg>
  );
}

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

  // --- Multi-select + bulk actions -----------------------------------------
  // Selection is client state keyed by experiment key. It deliberately survives
  // the 5s live refresh (nothing here remounts) and the search/business/status
  // filters. To honour "don't act on rows you can't see", every derived value
  // and every bulk call works off selectedVisibleKeys — the selection
  // INTERSECTED with the currently-filtered rows — so a key that scrolls out of
  // the filter (or is deleted under us on a refresh) is simply not acted on.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // The destructive confirm is ARMED FOR a specific count, not a bare boolean —
  // deriving "are we confirming?" from whether that armed count still matches
  // the live selection means a filter reflow or a new tick that changes the
  // count silently disarms the confirm, with no reset-in-effect (React's "you
  // might not need an effect").
  const [confirmArmedFor, setConfirmArmedFor] = useState<number | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkPending, startBulk] = useTransition();
  const selectAllRef = useRef<HTMLInputElement>(null);
  const cancelBulkRef = useRef<HTMLButtonElement>(null);

  const filteredKeys = useMemo(() => filtered.map((r) => r.key), [filtered]);
  const selectedVisibleKeys = useMemo(
    () => filteredKeys.filter((k) => selected.has(k)),
    [filteredKeys, selected],
  );
  const selectedCount = selectedVisibleKeys.length;
  const allVisibleSelected =
    filteredKeys.length > 0 && selectedCount === filteredKeys.length;
  const someVisibleSelected = selectedCount > 0 && !allVisibleSelected;
  // Derived: confirming only while the armed count still matches the selection.
  const confirmingDelete = selectedCount > 0 && confirmArmedFor === selectedCount;

  // The header checkbox's third, "partial" state — not expressible in JSX, so
  // it's driven imperatively whenever the visible-selection balance changes.
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  // Send focus to Cancel when the destructive confirm opens — the safe default
  // for a keyboard operator, matching ExperimentControls' single-row confirm.
  // A DOM call, not a setState, so it belongs in an effect.
  useEffect(() => {
    if (confirmingDelete) cancelBulkRef.current?.focus();
  }, [confirmingDelete]);

  function toggleRow(key: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSelectAll(): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const k of filteredKeys) next.delete(k);
      else for (const k of filteredKeys) next.add(k);
      return next;
    });
  }

  function runBulk(action: "pause" | "activate" | "delete"): void {
    const keys = selectedVisibleKeys;
    if (keys.length === 0 || bulkPending) return;
    setBulkError(null);
    startBulk(async () => {
      const result =
        action === "delete"
          ? await bulkDeleteExperiments(keys)
          : await bulkSetExperimentsActive(keys, action === "activate");
      setSelected(new Set());
      setConfirmArmedFor(null);
      if (result.failed.length > 0) {
        const shown = result.failed.slice(0, 3).map((f) => f.key).join(", ");
        const more = result.failed.length > 3 ? ` +${result.failed.length - 3} more` : "";
        setBulkError(
          `${result.failed.length} of ${keys.length} could not be updated (${shown}${more}).`,
        );
      }
      router.refresh();
    });
  }

  const selectCls =
    "rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg outline-none transition-colors hover:border-line-strong focus-visible:border-accent";
  // Same compact recipe as ExperimentControls' per-row buttons, so the bulk bar
  // reads as one family with the Actions column.
  const bulkBtnBase =
    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

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

      {/* Bulk action bar — mounts only when ≥1 currently-visible row is
          selected. A labelled region with an aria-live count so a screen reader
          hears the selection grow/shrink; the buttons drive the bulk server
          actions over selectedVisibleKeys. */}
      {selectedCount > 0 && (
        <div
          role="region"
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line-strong bg-surface px-4 py-2.5"
        >
          <span
            role="status"
            aria-live="polite"
            className="font-mono text-xs font-semibold tabular-nums text-fg"
          >
            {selectedCount} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => runBulk("pause")}
              disabled={bulkPending}
              className={`${bulkBtnBase} border border-warn/40 bg-warn/10 text-warn hover:bg-warn/20`}
            >
              {bulkPending ? "…" : "Pause"}
            </button>
            <button
              type="button"
              onClick={() => runBulk("activate")}
              disabled={bulkPending}
              className={`${bulkBtnBase} border border-good/40 bg-good/10 text-good hover:bg-good/20`}
            >
              {bulkPending ? "…" : "Activate"}
            </button>
            {!confirmingDelete ? (
              <button
                type="button"
                onClick={() => setConfirmArmedFor(selectedCount)}
                disabled={bulkPending}
                className={`${bulkBtnBase} border border-line-strong bg-surface text-faint hover:border-bad/40 hover:text-bad`}
              >
                Delete
              </button>
            ) : (
              <span
                className="flex items-center gap-1.5"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setConfirmArmedFor(null);
                }}
              >
                <button
                  type="button"
                  onClick={() => runBulk("delete")}
                  disabled={bulkPending}
                  className={`${bulkBtnBase} border border-bad/50 bg-bad/15 text-bad hover:bg-bad/25`}
                >
                  {bulkPending
                    ? "Deleting…"
                    : `Delete ${selectedCount} experiment${selectedCount === 1 ? "" : "s"}?`}
                </button>
                <button
                  type="button"
                  ref={cancelBulkRef}
                  onClick={() => setConfirmArmedFor(null)}
                  disabled={bulkPending}
                  className={`${bulkBtnBase} border border-line-strong bg-surface text-muted hover:text-fg`}
                >
                  Cancel
                </button>
              </span>
            )}
          </div>
          {bulkError && (
            <p role="alert" className="w-full text-[11px] text-bad sm:w-auto">
              {bulkError}
            </p>
          )}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[880px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-line font-mono text-[11px] uppercase tracking-wider text-muted">
              <th scope="col" className="w-10 px-4 py-3 font-medium">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="size-4 cursor-pointer align-middle accent-accent"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAll}
                  disabled={filteredKeys.length === 0}
                  aria-label={
                    allVisibleSelected
                      ? "Deselect all experiments"
                      : "Select all experiments"
                  }
                />
              </th>
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
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
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
                  {/* Select — stopPropagation so ticking the box never fires
                      the row's navigate-to-detail (that guard only spares <a>),
                      mirroring the Actions cell below. */}
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="size-4 cursor-pointer align-middle accent-accent"
                      checked={selected.has(row.key)}
                      onChange={() => toggleRow(row.key)}
                      aria-label={`Select ${row.name}`}
                    />
                  </td>
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
                    <Sparkline data={row.trend} />
                  </td>
                  {/* Today */}
                  <td className="px-4 py-3 text-right">
                    <TodayCell row={row} />
                  </td>
                  {/* Actions — stopPropagation so a Pause/Activate/Clone click
                      doesn't also fire the row's navigate-to-detail onClick
                      (that guard only ignores clicks inside an <a>). */}
                  <td className="px-4 py-3">
                    <div onClick={(e) => e.stopPropagation()}>
                      <ExperimentControls
                        experimentKey={row.key}
                        active={row.active}
                        variant="card"
                        allowDelete={false}
                      />
                    </div>
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
