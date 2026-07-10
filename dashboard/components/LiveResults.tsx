"use client";

// Live results + verdict — fetches /api/experiments/[key]/results client-side so
// the page shell paints instantly and this block streams in with its own loading /
// empty / error states. Renders (Phase 2): the per-variant acquisition FUNNEL
// (ad clicks → conversions → apps → paid → rebill), a revenue-per-acquired
// comparison chart, the per-variant P&L table (now with net revenue, break-even
// CAC, and ad metrics, currency-aware), the significance tests, winners, the
// verdict pill + narrative.
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
        const res = await fetch(`/api/experiments/${experimentKey}/results`, {
          cache: "no-store",
        });
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

  // A concise, screen-reader-only status line carries the state transition
  // (loading → ready / empty). The results themselves stay OUT of the live
  // region so a screen reader announces "Results loaded", not the entire P&L
  // table read aloud. Errors are announced by ResultsError's own role="alert"
  // (assertive), so the status stays silent for that state to avoid a double
  // announcement.
  const statusText =
    state.status === "loading"
      ? "Loading results…"
      : state.status === "empty"
        ? "No results available."
        : state.status === "ready"
          ? "Results loaded."
          : "";

  return (
    <div aria-busy={state.status === "loading"}>
      <p className="sr-only" role="status">
        {statusText}
      </p>
      {state.status === "loading" ? (
        <ResultsSkeleton />
      ) : state.status === "error" ? (
        <ResultsError message={state.message} />
      ) : state.status === "empty" ? (
        <ResultsEmpty reason={state.reason} />
      ) : (
        <ResultsReady rows={state.rows} verdict={state.verdict} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers (currency-aware)
// ---------------------------------------------------------------------------

const SYMBOL: Record<string, string> = { GBP: "£", EUR: "€", USD: "$" };
const sym = (ccy?: string) => (ccy && SYMBOL[ccy]) || "£";
const money = (n: number | undefined, ccy?: string) =>
  `${sym(ccy)}${(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number | undefined) => `${(n ?? 0).toFixed(1)}%`;
const intl = (n: number | undefined) => (n ?? 0).toLocaleString();
const ratio = (a: number, b: number) => (b > 0 ? (100 * a) / b : 0);

function signed(n: number, unit: "pp" | "£" | "%") {
  const s = n >= 0 ? "+" : "";
  if (unit === "£") return `${s}£${n.toFixed(2)}`;
  if (unit === "pp") return `${s}${n.toFixed(1)}pp`;
  return `${s}${n.toFixed(0)}%`;
}

// ---------------------------------------------------------------------------
// Ready state
// ---------------------------------------------------------------------------

function ResultsReady({ rows, verdict }: { rows: VariantRow[]; verdict: Verdict }) {
  // Experiment display currency — the dominant transacted currency across arms.
  const expCcy = rows.find((r) => r.currency)?.currency;
  const hasAds = rows.some((r) => (r.adClicks ?? 0) > 0);

  return (
    <div className="space-y-6">
      {/* Verdict header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-5">
        <div>
          <h3 className="font-display text-sm font-semibold text-fg">Verdict</h3>
          <p className="mt-0.5 text-xs text-muted">
            Measured against control{" "}
            <code className="font-mono text-faint">{verdict.controlVariant}</code>
            {expCcy && (
              <>
                {" · "}
                <span className="text-faint">revenue in {expCcy}</span>
              </>
            )}
          </p>
        </div>
        <VerdictPill recommendation={verdict.recommendation} />
      </div>

      <FunnelSection rows={rows} hasAds={hasAds} />
      <RevChart rows={rows} verdict={verdict} ccy={expCcy} />
      <PerVariantTable rows={rows} verdict={verdict} ccy={expCcy} hasAds={hasAds} />
      <SignificanceTable significance={verdict.significance} />
      <WinnersGrid verdict={verdict} ccy={expCcy} />
      <Narrative narrative={verdict.narrative} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Acquisition funnel (per variant) — ad clicks → conversions → apps → paid → rebill
// ---------------------------------------------------------------------------

function FunnelSection({ rows, hasAds }: { rows: VariantRow[]; hasAds: boolean }) {
  return (
    <section className="rounded-xl border border-line bg-surface">
      <header className="border-b border-line px-5 py-3">
        <h3 className="font-display text-sm font-semibold text-fg">Acquisition funnel</h3>
        <p className="mt-0.5 text-xs text-faint">
          {hasAds ? "Ad click" : "App"} → revenue, per variant.
        </p>
      </header>
      <div className="grid gap-4 p-5 sm:grid-cols-2">
        {rows.map((r) => (
          <VariantFunnel key={r.variant} row={r} hasAds={hasAds} />
        ))}
      </div>
    </section>
  );
}

function VariantFunnel({ row, hasAds }: { row: VariantRow; hasAds: boolean }) {
  const stages = [
    ...(hasAds
      ? [
          { label: "Ad clicks", value: row.adClicks ?? 0, note: "" },
          {
            label: "Conversions",
            value: row.adConversions ?? 0,
            note: `${ratio(row.adConversions ?? 0, row.adClicks ?? 0).toFixed(0)}% of clicks`,
          },
        ]
      : []),
    { label: "Apps", value: row.appsAcquired, note: "" },
    { label: "First-paid", value: row.firstPaid, note: `${pct(row.authRate)} auth` },
    { label: "Rebill", value: row.rebillOk, note: `${pct(row.rebillRate)} rebill` },
  ];
  const max = Math.max(1, ...stages.map((s) => s.value));

  return (
    <div className="rounded-lg border border-line bg-bg p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-xs font-semibold text-fg">{row.variant}</span>
        {row.isControl && <ControlBadge />}
        <code className="ml-auto font-mono text-[10px] text-faint">{row.themeSlug}</code>
      </div>
      <div className="space-y-2">
        {stages.map((s, i) => (
          <div key={s.label}>
            <div className="mb-1 flex items-baseline justify-between text-[11px]">
              <span className="text-muted">{s.label}</span>
              <span className="tabular-nums text-fg">
                {intl(s.value)}
                {s.note && <span className="ml-1.5 text-faint">{s.note}</span>}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
              <div
                className={i === stages.length - 1 ? "h-full bg-info/70" : "h-full bg-accent/70"}
                style={{ width: `${Math.max(2, (s.value / max) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revenue-per-acquired comparison chart (the money metric)
// ---------------------------------------------------------------------------

function RevChart({
  rows,
  verdict,
  ccy,
}: {
  rows: VariantRow[];
  verdict: Verdict;
  ccy?: string;
}) {
  const winner = verdict.winners.find((w) => w.metric === "rev_per_acquired")?.winner;
  // Prefer native revenue/acquired; fall back to the GBP figure.
  const valOf = (r: VariantRow) => r.revPerAcquiredNative ?? r.revPerAcquired;
  const max = Math.max(1, ...rows.map(valOf));

  return (
    <section className="rounded-xl border border-line bg-surface">
      <header className="border-b border-line px-5 py-3">
        <h3 className="font-display text-sm font-semibold text-fg">Revenue per acquired</h3>
        <p className="mt-0.5 text-xs text-faint">The money metric — collected-to-date.</p>
      </header>
      <div className="space-y-3 p-5">
        {rows.map((r) => {
          const v = valOf(r);
          const isWinner = r.variant === winner;
          return (
            <div key={r.variant} className="flex items-center gap-3">
              <div className="flex w-28 shrink-0 items-center gap-1.5">
                <span className="truncate font-mono text-xs text-fg">{r.variant}</span>
                {r.isControl && <ControlBadge />}
              </div>
              <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-bg">
                <div
                  className={`h-full ${isWinner ? "bg-accent" : "bg-accent-soft"}`}
                  style={{ width: `${Math.max(3, (v / max) * 100)}%` }}
                />
              </div>
              <span
                className={`w-24 shrink-0 text-right font-semibold tabular-nums ${isWinner ? "text-accent" : "text-fg"}`}
              >
                {money(v, r.currency ?? ccy)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Per-variant P&L table (extended: net revenue, break-even CAC, ad metrics)
// ---------------------------------------------------------------------------

function PerVariantTable({
  rows,
  verdict,
  ccy,
  hasAds,
}: {
  rows: VariantRow[];
  verdict: Verdict;
  ccy?: string;
  hasAds: boolean;
}) {
  const revWinner = verdict.winners.find((w) => w.metric === "rev_per_acquired")?.winner;
  return (
    <section className="rounded-xl border border-line bg-surface">
      <header className="border-b border-line px-5 py-3">
        <h3 className="font-display text-sm font-semibold text-fg">Per-variant P&amp;L</h3>
        <p className="mt-0.5 text-xs text-faint">
          Cohort-clean, collected-to-date. Net = revenue − refunds − chargebacks.
          Break-even CAC = net ÷ acquired (max you can pay per acquisition).
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="text-left font-mono text-[11px] uppercase tracking-wider text-faint">
              <th scope="col" className="px-5 py-2.5 font-medium">Variant</th>
              {hasAds && <th scope="col" className="px-3 py-2.5 text-right font-medium">Clicks</th>}
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Apps</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Auth %</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Rebill %</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Net rev (GBP)</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Break-even CAC</th>
              <th scope="col" className="px-5 py-2.5 text-right font-medium">Rev / acq</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => {
              const isRevWinner = r.variant === revWinner;
              return (
                <tr key={r.variant} className="text-fg transition-colors hover:bg-surface-hover">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold">{r.variant}</span>
                      {r.isControl && <ControlBadge />}
                    </div>
                    <code className="mt-0.5 block font-mono text-[11px] text-faint">
                      {r.themeSlug}
                    </code>
                  </td>
                  {hasAds && (
                    <td className="px-3 py-3 text-right tabular-nums text-muted">
                      {intl(r.adClicks)}
                    </td>
                  )}
                  <td className="px-3 py-3 text-right tabular-nums text-muted">
                    {intl(r.appsAcquired)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted">{pct(r.authRate)}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted">{pct(r.rebillRate)}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted">
                    {money(r.netRevenueGbp ?? r.revenueGbp, "GBP")}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted">
                    {money(r.breakEvenCacGbp, "GBP")}
                  </td>
                  <td
                    className={`px-5 py-3 text-right font-semibold tabular-nums ${isRevWinner ? "text-accent" : "text-fg"}`}
                  >
                    {money(r.revPerAcquiredNative ?? r.revPerAcquired, r.currency ?? ccy)}
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

// ---------------------------------------------------------------------------
// Significance (unchanged)
// ---------------------------------------------------------------------------

function SignificanceTable({ significance }: { significance: SignificanceTest[] }) {
  if (significance.length === 0) return null;
  return (
    <section className="rounded-xl border border-line bg-surface">
      <header className="border-b border-line px-5 py-3">
        <h3 className="font-display text-sm font-semibold text-fg">Significance vs control</h3>
        <p className="mt-0.5 text-xs text-faint">Two-proportion z-test, two-tailed.</p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left font-mono text-[11px] uppercase tracking-wider text-faint">
              <th scope="col" className="px-5 py-2.5 font-medium">Metric · variant</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Control</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Variant</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Δ pp</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">z</th>
              <th scope="col" className="px-5 py-2.5 text-right font-medium">Verdict</th>
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
                  <td className="px-5 py-3 font-mono text-xs text-fg">{t.metric}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted">
                    {pct(t.controlRate * 100)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted">
                    {pct(t.variantRate * 100)}
                  </td>
                  <td className={`px-3 py-3 text-right font-medium tabular-nums ${color}`}>
                    {signed(t.deltaPp, "pp")}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted">{t.z.toFixed(2)}</td>
                  <td className={`px-5 py-3 text-right text-xs ${color}`}>{t.label}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WinnersGrid({ verdict, ccy }: { verdict: Verdict; ccy?: string }) {
  const labels: Record<string, string> = {
    auth_rate: "Auth rate",
    rebill_rate: "Rebill rate",
    rev_per_acquired: "Rev / acquired",
  };
  return (
    <section className="grid gap-3 sm:grid-cols-3">
      {verdict.winners.map((w) => {
        const isControl = w.winner === verdict.controlVariant;
        const isMoney = w.metric === "rev_per_acquired";
        const fmt = (n: number) => (isMoney ? money(n, ccy) : pct(n));
        return (
          <div key={w.metric} className="rounded-xl border border-line bg-surface p-4">
            <div className="font-mono text-[10px] font-medium uppercase tracking-wider text-faint">
              {labels[w.metric]}
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="font-display text-2xl font-bold tabular-nums text-fg">
                {fmt(w.winnerValue)}
              </span>
              <span className="font-mono text-xs font-semibold text-accent">
                {w.winner}
              </span>
            </div>
            <div className="mt-1 text-xs text-muted">
              {isControl ? (
                <span className="text-faint">control holds</span>
              ) : (
                <>
                  {signed(w.delta, isMoney ? "£" : "pp")}{" "}
                  <span className="text-faint">({signed(w.deltaRel * 100, "%")}) vs control</span>
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
      <h3 className="font-display text-sm font-semibold text-fg">Recommendation narrative</h3>
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
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="skeleton h-48" />
        <div className="skeleton h-48" />
      </div>
      <div className="skeleton h-44 w-full" />
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
      <h3 className="font-display text-sm font-semibold text-fg">Connect Metabase to see live results</h3>
      <p className="mt-1.5 max-w-md text-xs leading-relaxed text-muted">
        Live per-variant P&amp;L and the verdict load from the global-api Postgres via
        Metabase. Set <code className="font-mono text-faint">METABASE_URL</code> and{" "}
        <code className="font-mono text-faint">METABASE_API_KEY</code> to enable them.
      </p>
      <p className="mt-3 font-mono text-[11px] text-faint">{reason}</p>
    </div>
  );
}

function ResultsError({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-xl border border-bad/30 bg-bad/5 px-5 py-6 text-center">
      <h3 className="text-sm font-semibold text-bad">Couldn&apos;t load results</h3>
      <p className="mt-1.5 font-mono text-xs text-bad/80">{message}</p>
    </div>
  );
}
