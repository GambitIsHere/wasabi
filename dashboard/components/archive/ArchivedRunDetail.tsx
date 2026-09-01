// ============================================================================
// Wasabi — the body of an archived run's detail: insight · KPI strip · per-
// variant conversion chart · full results table · payment read · hypothesis.
// ----------------------------------------------------------------------------
// Extracted from app/archive/[key]/page.tsx so the roadmap test page can show
// the SAME evidence inline for a re-run (a roadmap test that repeats an archived
// campaign renders the campaign it repeats, right there). Server component —
// pure presentation, no hooks, no client JS.
// ============================================================================
import type { ArchivedExperiment, ArchivedVariant } from "@/lib/archive";
import { int, Uplift } from "@/lib/archive-format";

function short(s: string, n = 24): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ---------------------------------------------------------------------------
// Per-variant conversion-rate chart (inline SVG, no external libraries). Bars
// scale to the max conversion rate; when every arm reads 0% (an unread run) it
// charts the traffic split instead. Theme-aware via --color-* CSS variables.
// ---------------------------------------------------------------------------
function VariantChart({
  variants,
  winnerVariant,
}: {
  variants: ArchivedVariant[];
  winnerVariant: string | null;
}) {
  const useCR = variants.some((v) => v.conversionRate > 0);
  const maxVal = Math.max(
    0,
    ...variants.map((v) => (useCR ? v.conversionRate : v.visitors)),
  );

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
            const isWinner = winnerVariant != null && v.key === winnerVariant;

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
                <rect
                  x={barX}
                  y={barY}
                  width={barMaxW}
                  height={barH}
                  rx={3}
                  style={{ fill: "var(--color-line-whisper)" }}
                />
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
// read has been attached (≥1 variant with a non-null auth rate).
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
        <h2 className="font-display text-sm font-semibold text-fg">Payment read</h2>
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
              const isWinner = winnerVariant != null && v.key === winnerVariant;
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
        Auth is first-payment success. R1–R3 are rebill collection at the 1st, 2nd
        and 3rd renewal cycle. Net £/acq is revenue less refunds and chargebacks,
        per acquired customer.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The full detail body. `compact` drops the KPI strip + hypothesis footer for
// the embedded (roadmap-test) placement, keeping insight + chart + results +
// payment — the evidence that matters when deciding to re-run.
// ---------------------------------------------------------------------------
export function ArchivedRunDetail({
  exp,
  compact = false,
}: {
  exp: ArchivedExperiment;
  compact?: boolean;
}) {
  const hasPayment = exp.variants.some((v) => v.authRate != null);
  return (
    <div className="space-y-6">
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

      {!compact && (
        <section className="grid grid-cols-3 gap-3 sm:max-w-lg">
          {[
            { label: "Visitors tested", value: int(exp.visitorsTotal) },
            { label: "Conversions", value: int(exp.conversionsTotal) },
            { label: "Variants", value: int(exp.variants.length) },
          ].map((s) => (
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
      )}

      {exp.variants.length > 0 && (
        <VariantChart variants={exp.variants} winnerVariant={exp.winnerVariant} />
      )}

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
                <th className="px-5 py-2 text-right font-medium">Chance to beat</th>
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

      {hasPayment && (
        <PaymentRead variants={exp.variants} winnerVariant={exp.winnerVariant} />
      )}

      {!compact && (exp.hypothesis || exp.notes) && (
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
