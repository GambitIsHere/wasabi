import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getArchived,
  type ArchivedExperiment,
  type ArchivedVariant,
} from "@/lib/archive";
import { STATUS, fmtDate, int, Uplift } from "@/lib/archive-format";

// DB-backed — resolve each archived key on request (routes aren't known at build).
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Per-variant conversion-rate chart (inline SVG, no external libraries).
// Bars are scaled to the max conversion rate in this experiment. When every
// arm reads 0% (an unread run), it falls back to charting the traffic split.
// Theme-aware: every colour is a --color-* CSS variable via inline style.
// ---------------------------------------------------------------------------

function short(s: string, n = 24): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function VariantChart({
  variants,
  winnerVariant,
}: {
  variants: ArchivedVariant[];
  winnerVariant: string | null;
}) {
  const useCR = variants.some((v) => v.conversionRate > 0);
  const values = variants.map((v) => (useCR ? v.conversionRate : v.visitors));
  const maxVal = Math.max(0, ...values);

  // Geometry (viewBox units).
  const rowH = 40;
  const topPad = 12;
  const bottomPad = 14;
  const barX = 176;
  const barMaxW = 340;
  const barH = 18;
  const valueX = barX + barMaxW + 12;
  const rightX = 852;
  const vbW = 860;
  const vbH = topPad + variants.length * rowH + bottomPad;

  return (
    <div className="space-y-3">
      <p className="eyebrow">
        {useCR ? "Conversion rate by variant" : "Traffic split by variant"}
      </p>
      <div className="overflow-x-auto rounded-xl border border-line bg-surface px-4 py-4">
        <svg
          viewBox={`0 0 ${vbW} ${vbH}`}
          role="img"
          aria-label={
            useCR
              ? "Conversion rate per variant"
              : "Visitor split per variant (no readable conversion data)"
          }
          style={{ width: "100%", minWidth: 620, height: "auto" }}
        >
          {/* Zero baseline / gridline. */}
          <line
            x1={barX}
            y1={topPad}
            x2={barX}
            y2={vbH - bottomPad}
            style={{ stroke: "var(--color-line)" }}
            strokeWidth={1}
          />
          {variants.map((v, i) => {
            const cy = topPad + i * rowH + rowH / 2;
            const barY = cy - barH / 2;
            const val = useCR ? v.conversionRate : v.visitors;
            const w = maxVal > 0 ? (val / maxVal) * barMaxW : 0;
            const isWinner =
              winnerVariant != null && v.key === winnerVariant;

            const fill = v.isControl
              ? "var(--color-faint)"
              : v.improvement != null && v.improvement > 0.05
                ? "var(--color-good)"
                : v.improvement != null && v.improvement < -0.05
                  ? "var(--color-bad)"
                  : "var(--color-info)";

            const upliftStr =
              v.isControl ||
              v.improvement == null ||
              Math.abs(v.improvement) < 0.05
                ? null
                : `${v.improvement > 0 ? "▲ +" : "▼ "}${v.improvement.toFixed(1)}%`;
            const upliftColor =
              v.improvement != null && v.improvement > 0
                ? "var(--color-good)"
                : "var(--color-bad)";
            const chanceStr =
              v.chanceToBeat != null
                ? `${v.chanceToBeat.toFixed(0)}% to beat`
                : null;

            return (
              <g key={v.key} style={{ fontVariantNumeric: "tabular-nums" }}>
                {/* Variant name. */}
                <text
                  x={8}
                  y={cy}
                  dominantBaseline="middle"
                  fontSize={12.5}
                  fontWeight={isWinner ? 600 : 400}
                  style={{
                    fill: isWinner ? "var(--color-accent)" : "var(--color-fg)",
                  }}
                >
                  {short(v.name)}
                  {isWinner ? " ★" : ""}
                </text>

                {/* Track. */}
                <rect
                  x={barX}
                  y={barY}
                  width={barMaxW}
                  height={barH}
                  rx={3}
                  style={{ fill: "var(--color-line-whisper)" }}
                />
                {/* Value bar. */}
                {w > 0 && (
                  <rect
                    x={barX}
                    y={barY}
                    width={w}
                    height={barH}
                    rx={3}
                    style={{
                      fill,
                      stroke: isWinner ? "var(--color-accent)" : "none",
                      strokeWidth: isWinner ? 1.5 : 0,
                    }}
                  />
                )}

                {/* Value at the bar end. */}
                <text
                  x={valueX}
                  y={cy}
                  dominantBaseline="middle"
                  fontSize={12.5}
                  fontWeight={600}
                  style={{
                    fill: "var(--color-fg)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {useCR ? `${val.toFixed(2)}%` : int(val)}
                </text>

                {/* Uplift · chance-to-beat, or the control tag. */}
                <text
                  x={rightX}
                  y={cy}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={12}
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {v.isControl ? (
                    <tspan style={{ fill: "var(--color-faint)" }}>control</tspan>
                  ) : (
                    <>
                      {upliftStr && (
                        <tspan style={{ fill: upliftColor, fontWeight: 500 }}>
                          {upliftStr}
                        </tspan>
                      )}
                      {upliftStr && chanceStr && (
                        <tspan style={{ fill: "var(--color-faint)" }}>
                          {"   ·   "}
                        </tspan>
                      )}
                      {chanceStr && (
                        <tspan style={{ fill: "var(--color-muted)" }}>
                          {chanceStr}
                        </tspan>
                      )}
                    </>
                  )}
                </text>
              </g>
            );
          })}
        </svg>
        {!useCR && (
          <p className="mt-2 text-xs text-faint">
            No readable conversion data — showing traffic split.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payment read — the "what VWO can't see" panel. Rendered only when a payment
// read has been attached (at least one variant has a non-null auth rate). Shows,
// per variant, the first-payment auth rate, rebill collection at cycles R1/R2/R3
// and net revenue per acquired customer — all live from global-api via Metabase.
// ---------------------------------------------------------------------------

function pctCell(v: number | null) {
  return v == null ? (
    <span className="text-faint">—</span>
  ) : (
    <span className="tabular-nums text-fg">{v.toFixed(1)}%</span>
  );
}

function gbpCell(v: number | null) {
  return v == null ? (
    <span className="text-faint">—</span>
  ) : (
    <span className="tabular-nums text-fg">£{v.toFixed(2)}</span>
  );
}

function PaymentRead({
  variants,
  winnerVariant,
}: {
  variants: ArchivedVariant[];
  winnerVariant: string | null;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <header className="border-b border-line px-5 py-3">
        <h2 className="font-display text-sm font-semibold text-fg">
          Payment read
        </h2>
        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-faint">
          What VWO can&apos;t see — live from global-api
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wide text-faint">
              <th className="px-5 py-2 font-medium">Variant</th>
              <th className="px-3 py-2 text-right font-medium">Auth</th>
              <th className="px-3 py-2 text-right font-medium">R1</th>
              <th className="px-3 py-2 text-right font-medium">R2</th>
              <th className="px-3 py-2 text-right font-medium">R3</th>
              <th className="px-5 py-2 text-right font-medium">Net £/acq</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {variants.map((v) => {
              const isWinner =
                winnerVariant != null && v.key === winnerVariant;
              return (
                <tr key={v.key} className={isWinner ? "bg-good/5" : undefined}>
                  <td className="px-5 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-fg">{v.name}</span>
                      {v.isControl && (
                        <span className="rounded bg-bg px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-faint">
                          control
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right">{pctCell(v.authRate)}</td>
                  <td className="px-3 py-2.5 text-right">{pctCell(v.rebillR1)}</td>
                  <td className="px-3 py-2.5 text-right">{pctCell(v.rebillR2)}</td>
                  <td className="px-3 py-2.5 text-right">{pctCell(v.rebillR3)}</td>
                  <td className="px-5 py-2.5 text-right">
                    {gbpCell(v.netRevPerAcquired)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-5 py-2.5 text-[11px] leading-relaxed text-faint">
        Auth is first-payment success. R1–R3 are rebill collection at the 1st,
        2nd and 3rd renewal cycle. Net £/acq is revenue less refunds and
        chargebacks, per acquired customer.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Detail page
// ---------------------------------------------------------------------------

export default async function ArchivedDetailPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const exp: ArchivedExperiment | undefined = await getArchived(key);
  if (!exp) notFound();

  const start = fmtDate(exp.startDate);
  const end = fmtDate(exp.endDate);
  const range = start && end ? `${start} – ${end}` : (start ?? end ?? "date n/a");
  const winner = exp.winnerVariant
    ? exp.variants.find((v) => v.key === exp.winnerVariant)
    : undefined;

  const kpis = [
    { label: "Visitors tested", value: int(exp.visitorsTotal) },
    { label: "Conversions", value: int(exp.conversionsTotal) },
    { label: "Variants", value: int(exp.variants.length) },
  ];

  return (
    <div className="space-y-8">
      {/* 1. Back link */}
      <Link
        href="/archive"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-faint transition-colors hover:text-fg"
      >
        <span aria-hidden="true">←</span> Archive
      </Link>

      {/* 2. Header */}
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-bg px-2 py-0.5 font-mono text-[10px] text-muted">
            {exp.business}
          </span>
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide ${STATUS[exp.status].cls}`}
          >
            {STATUS[exp.status].label}
          </span>
          {exp.type && (
            <span className="font-mono text-[10px] uppercase tracking-wide text-faint">
              {exp.type}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="max-w-3xl font-display text-3xl font-bold tracking-tight text-fg sm:text-4xl">
            {exp.name}
          </h1>
          {exp.sourceUrl && (
            <a
              href={exp.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 font-mono text-xs text-info hover:underline"
            >
              report ↗
            </a>
          )}
        </div>

        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-faint">
          <span>{range}</span>
          {exp.goalMetric && <span>goal · {exp.goalMetric}</span>}
          <span className="uppercase">{exp.source}</span>
          {exp.sourceId && <span>#{exp.sourceId}</span>}
        </div>

        {winner && (
          <p className="text-sm text-muted">
            Winner —{" "}
            <span className="font-medium text-good">{winner.name}</span> took the
            run.
          </p>
        )}
      </header>

      {/* 3. Insight */}
      {exp.insight && (
        <section className="rounded-xl border border-accent/25 bg-accent/5 px-5 py-4">
          <p className="text-sm leading-relaxed text-fg">
            <span className="mr-2 font-mono text-[10px] font-semibold uppercase tracking-wide text-accent">
              Insight
            </span>
            {exp.insight}
          </p>
        </section>
      )}

      {/* 4. KPI strip */}
      <section className="grid grid-cols-3 gap-3 sm:max-w-lg">
        {kpis.map((s) => (
          <div
            key={s.label}
            className="rounded-xl border border-line bg-surface px-4 py-3"
          >
            <div className="font-display text-2xl font-bold tabular-nums text-fg">
              {s.value}
            </div>
            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-faint">
              {s.label}
            </div>
          </div>
        ))}
      </section>

      {/* 5. Chart */}
      {exp.variants.length > 0 && (
        <VariantChart
          variants={exp.variants}
          winnerVariant={exp.winnerVariant}
        />
      )}

      {/* 6. Full results table */}
      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <header className="border-b border-line px-5 py-3">
          <h2 className="font-display text-sm font-semibold text-fg">Results</h2>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wide text-faint">
                <th className="px-5 py-2 font-medium">Variant</th>
                <th className="px-3 py-2 text-right font-medium">Visitors</th>
                <th className="px-3 py-2 text-right font-medium">Conv.</th>
                <th className="px-3 py-2 text-right font-medium">CR</th>
                <th className="px-3 py-2 text-right font-medium">Uplift</th>
                <th className="px-5 py-2 text-right font-medium">
                  Chance to beat
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {exp.variants.map((v) => {
                const isWinner =
                  exp.winnerVariant != null && v.key === exp.winnerVariant;
                return (
                  <tr key={v.key} className={isWinner ? "bg-good/5" : undefined}>
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="text-fg">{v.name}</span>
                        {v.isControl && (
                          <span className="rounded bg-bg px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-faint">
                            control
                          </span>
                        )}
                        {isWinner && (
                          <span className="rounded bg-good/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-good">
                            winner
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted">
                      {int(v.visitors)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted">
                      {int(v.conversions)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-fg">
                      {v.conversionRate.toFixed(2)}%
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {v.isControl ? (
                        <span className="text-faint">—</span>
                      ) : (
                        <Uplift value={v.improvement} />
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-muted">
                      {v.chanceToBeat != null
                        ? `${v.chanceToBeat.toFixed(1)}%`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* 6.5. Payment read — only when a payment read has been attached. */}
      {exp.variants.some((v) => v.authRate != null) && (
        <PaymentRead
          variants={exp.variants}
          winnerVariant={exp.winnerVariant}
        />
      )}

      {/* 7. Hypothesis & notes */}
      {(exp.hypothesis || exp.notes) && (
        <footer className="rounded-xl border border-line bg-surface px-5 py-4 text-xs leading-relaxed text-muted">
          {exp.hypothesis && (
            <p>
              <span className="font-mono uppercase tracking-wide text-faint">
                Hypothesis ·{" "}
              </span>
              {exp.hypothesis}
            </p>
          )}
          {exp.notes && (
            <p className={exp.hypothesis ? "mt-2" : undefined}>
              <span className="font-mono uppercase tracking-wide text-faint">
                Notes ·{" "}
              </span>
              {exp.notes}
            </p>
          )}
        </footer>
      )}
    </div>
  );
}
