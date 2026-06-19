"use client";

// Live results + verdict — fetches /api/experiments/[key]/results client-side
// so the page shell paints instantly and this block streams in with its own
// loading skeleton, empty-state, and error-state. Renders the per-variant P&L
// table, the significance tests vs control, winner-by-metric, and the verdict
// pill + narrative.
import { useEffect, useState } from "react";
import type { VariantRow, Verdict, SignificanceTest } from "@/lib/verdict";
import { VerdictPill, ControlBadge } from "@/components/pills";

interface ResultsBody {
  available: boolean;
  rows?: VariantRow[];
  verdict?: Verdict;
  reason?: string;
}

type FetchState =
  | { status: "loading" }
  | { status: "empty"; reason: string }
  | { status: "error"; message: string }
  | { status: "ready"; rows: VariantRow[]; verdict: Verdict };

interface Props {
  experimentKey: string;
}

export function LiveResults({ experimentKey }: Props) {
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/experiments/${experimentKey}/results`,
          { cache: "no-store" },
        );
        const body = (await res.json()) as ResultsBody;
        if (cancelled) return;
        if (body.available && body.rows && body.verdict) {
          setState({ status: "ready", rows: body.rows, verdict: body.verdict });
        } else {
          setState({
            status: "empty",
            reason: body.reason ?? "No results available",
          });
        }
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Request failed",
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [experimentKey]);

  if (state.status === "loading") return <ResultsSkeleton />;
  if (state.status === "error") return <ResultsError message={state.message} />;
  if (state.status === "empty") return <ResultsEmpty reason={state.reason} />;

  return <ResultsReady rows={state.rows} verdict={state.verdict} />;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const gbp = (n: number) => `£${n.toFixed(2)}`;
const pct = (n: number) => `${n.toFixed(1)}%`;
const intl = (n: number) => n.toLocaleString();

function signed(n: number, unit: "pp" | "£" | "%") {
  const s = n >= 0 ? "+" : "";
  if (unit === "£") return `${s}£${n.toFixed(2)}`;
  if (unit === "pp") return `${s}${n.toFixed(1)}pp`;
  return `${s}${n.toFixed(0)}%`;
}

// ---------------------------------------------------------------------------
// Ready state
// ---------------------------------------------------------------------------

function ResultsReady({
  rows,
  verdict,
}: {
  rows: VariantRow[];
  verdict: Verdict;
}) {
  return (
    <div className="space-y-6">
      {/* Verdict header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-5">
        <div>
          <h3 className="text-sm font-semibold text-fg">Verdict</h3>
          <p className="mt-0.5 text-xs text-muted">
            Measured against control{" "}
            <code className="font-mono text-faint">
              {verdict.controlVariant}
            </code>
          </p>
        </div>
        <VerdictPill recommendation={verdict.recommendation} />
      </div>

      <PerVariantTable rows={rows} verdict={verdict} />
      <SignificanceTable significance={verdict.significance} />
      <WinnersGrid verdict={verdict} />
      <Narrative narrative={verdict.narrative} />
    </div>
  );
}

function PerVariantTable({
  rows,
  verdict,
}: {
  rows: VariantRow[];
  verdict: Verdict;
}) {
  return (
    <section className="rounded-xl border border-line bg-surface">
      <header className="border-b border-line px-5 py-3">
        <h3 className="text-sm font-semibold text-fg">Per-variant P&amp;L</h3>
        <p className="mt-0.5 text-xs text-faint">
          Cohort-clean, collected-to-date.
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-faint">
              <th className="px-5 py-2.5 font-medium">Variant</th>
              <th className="px-3 py-2.5 text-right font-medium">Apps</th>
              <th className="px-3 py-2.5 text-right font-medium">Auth %</th>
              <th className="px-3 py-2.5 text-right font-medium">Rebill %</th>
              <th className="px-3 py-2.5 text-right font-medium">Revenue</th>
              <th className="px-5 py-2.5 text-right font-medium">Rev / acq</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => {
              const isRevWinner =
                verdict.winners.find((w) => w.metric === "rev_per_acquired")
                  ?.winner === r.variant;
              return (
                <tr
                  key={r.variant}
                  className="text-fg transition-colors hover:bg-surface-hover"
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold">
                        {r.variant}
                      </span>
                      {r.isControl && <ControlBadge />}
                    </div>
                    <code className="mt-0.5 block font-mono text-[11px] text-faint">
                      {r.themeSlug}
                    </code>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted">
                    {intl(r.appsAcquired)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted">
                    {pct(r.authRate)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted">
                    {pct(r.rebillRate)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted">
                    {gbp(r.revenueGbp)}
                  </td>
                  <td
                    className={`px-5 py-3 text-right font-semibold tabular-nums ${
                      isRevWinner ? "text-accent" : "text-fg"
                    }`}
                  >
                    {gbp(r.revPerAcquired)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SignificanceTable({
  significance,
}: {
  significance: SignificanceTest[];
}) {
  if (significance.length === 0) return null;
  return (
    <section className="rounded-xl border border-line bg-surface">
      <header className="border-b border-line px-5 py-3">
        <h3 className="text-sm font-semibold text-fg">
          Significance vs control
        </h3>
        <p className="mt-0.5 text-xs text-faint">
          Two-proportion z-test, two-tailed.
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-faint">
              <th className="px-5 py-2.5 font-medium">Metric · variant</th>
              <th className="px-3 py-2.5 text-right font-medium">Control</th>
              <th className="px-3 py-2.5 text-right font-medium">Variant</th>
              <th className="px-3 py-2.5 text-right font-medium">Δ pp</th>
              <th className="px-3 py-2.5 text-right font-medium">z</th>
              <th className="px-5 py-2.5 text-right font-medium">Verdict</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {significance.map((t) => {
              const color = !t.significant
                ? "text-faint"
                : t.deltaPp >= 0
                  ? "text-good"
                  : "text-bad";
              return (
                <tr key={t.metric} className="hover:bg-surface-hover">
                  <td className="px-5 py-3 font-mono text-xs text-fg">
                    {t.metric}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted">
                    {pct(t.controlRate * 100)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted">
                    {pct(t.variantRate * 100)}
                  </td>
                  <td
                    className={`px-3 py-3 text-right font-medium tabular-nums ${color}`}
                  >
                    {signed(t.deltaPp, "pp")}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted">
                    {t.z.toFixed(2)}
                  </td>
                  <td className={`px-5 py-3 text-right text-xs ${color}`}>
                    {t.label}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WinnersGrid({ verdict }: { verdict: Verdict }) {
  const labels: Record<string, string> = {
    auth_rate: "Auth rate",
    rebill_rate: "Rebill rate",
    rev_per_acquired: "Rev / acquired",
  };
  return (
    <section className="grid gap-3 sm:grid-cols-3">
      {verdict.winners.map((w) => {
        const isControl = w.winner === verdict.controlVariant;
        const unit = w.metric === "rev_per_acquired" ? "£" : "%";
        const fmt = (n: number) =>
          unit === "£" ? gbp(n) : pct(n);
        return (
          <div
            key={w.metric}
            className="rounded-xl border border-line bg-surface p-4"
          >
            <div className="text-[11px] font-medium uppercase tracking-wide text-faint">
              {labels[w.metric]}
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="font-mono text-sm font-semibold text-accent">
                {w.winner}
              </span>
              <span className="text-sm font-semibold text-fg">
                {fmt(w.winnerValue)}
              </span>
            </div>
            <div className="mt-1 text-xs text-muted">
              {isControl ? (
                <span className="text-faint">control holds</span>
              ) : (
                <>
                  {signed(w.delta, unit === "£" ? "£" : "pp")}{" "}
                  <span className="text-faint">
                    ({signed(w.deltaRel * 100, "%")}) vs control
                  </span>
                </>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Narrative({ narrative }: { narrative: string }) {
  const paragraphs = narrative.split("\n\n");
  return (
    <section className="rounded-xl border border-line bg-bg-elevated p-5">
      <h3 className="text-sm font-semibold text-fg">Recommendation narrative</h3>
      <div className="mt-3 space-y-3">
        {paragraphs.map((para, i) => {
          const isRec = para.startsWith("RECOMMENDATION");
          return (
            <p
              key={i}
              className={
                isRec
                  ? "rounded-lg border border-accent/25 bg-accent/5 px-3 py-2.5 text-sm leading-relaxed text-fg"
                  : "text-sm leading-relaxed text-muted"
              }
            >
              {para}
            </p>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Loading / empty / error states
// ---------------------------------------------------------------------------

function ResultsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading results">
      <div className="skeleton h-16 w-full" />
      <div className="skeleton h-44 w-full" />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="skeleton h-24" />
        <div className="skeleton h-24" />
        <div className="skeleton h-24" />
      </div>
    </div>
  );
}

function ResultsEmpty({ reason }: { reason: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
      <div
        className="mb-3 flex size-11 items-center justify-center rounded-full border border-line-strong bg-bg text-lg"
        aria-hidden="true"
      >
        🔌
      </div>
      <h3 className="text-sm font-semibold text-fg">
        Connect Metabase to see live results
      </h3>
      <p className="mt-1.5 max-w-md text-xs leading-relaxed text-muted">
        Live per-variant P&amp;L and the verdict load from the global-api
        Postgres via Metabase. Set{" "}
        <code className="font-mono text-faint">METABASE_URL</code> and{" "}
        <code className="font-mono text-faint">METABASE_API_KEY</code> to enable
        them.
      </p>
      <p className="mt-3 font-mono text-[11px] text-faint">{reason}</p>
    </div>
  );
}

function ResultsError({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-bad/30 bg-bad/5 px-5 py-6 text-center">
      <h3 className="text-sm font-semibold text-bad">
        Couldn&apos;t load results
      </h3>
      <p className="mt-1.5 font-mono text-xs text-bad/80">{message}</p>
    </div>
  );
}
