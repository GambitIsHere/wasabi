import Link from "next/link";
import { listArchived, type ArchivedExperiment } from "@/lib/archive";
import { STATUS, dateRange, int, Uplift } from "@/lib/archive-format";
import { forwardLinkBySourceId } from "@/lib/tested-elements";

// Reads the archive from the DB on every load — imports land here.
export const dynamic = "force-dynamic";

export default async function ArchivePage() {
  let experiments: ArchivedExperiment[] = [];
  let loadError: string | null = null;
  try {
    experiments = await listArchived();
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const winners = experiments.filter((e) => e.status === "winner").length;
  const visitors = experiments.reduce((s, e) => s + e.visitorsTotal, 0);

  // Which runs point forward to the plan — a scheduled re-run, or a candidate.
  const forward = forwardLinkBySourceId();

  return (
    <div className="space-y-8">
      {/* Header */}
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-3">
          <p className="eyebrow">From VWO / Wingify</p>
          <h1 className="font-display text-4xl font-bold tracking-tight text-fg sm:text-5xl">
            Past <span className="serif-accent">experiments</span>
          </h1>
          <p className="max-w-2xl text-muted">
            Completed runs migrated from VWO with their results attached —
            visitors, conversion rate, uplift and significance per arm. The
            record VWO is being retired for.
          </p>
        </div>
        <Link
          href="/admin/import-vwo"
          className="rounded-lg border border-line-strong bg-surface px-4 py-2 font-display text-sm font-semibold text-fg transition-colors hover:border-accent/50 hover:text-accent"
        >
          Import from VWO
        </Link>
      </section>

      {/* Summary strip */}
      {experiments.length > 0 && (
        <section className="grid grid-cols-3 gap-3 sm:max-w-lg">
          {[
            { label: "Experiments", value: int(experiments.length) },
            { label: "Winners", value: int(winners) },
            { label: "Visitors tested", value: int(visitors) },
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

      {/* Coverage caveat — VWO's API returns only running + paused; the survivor set. */}
      {experiments.length > 0 && (
        <section className="rounded-xl border border-info/25 bg-info/5 px-5 py-4">
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-0.5 shrink-0 text-info">◑</span>
            <div className="space-y-1.5 text-sm leading-relaxed">
              <p className="font-display font-semibold text-info">
                Coverage — this is 50 of 84 known 2026 campaigns, and it&apos;s the survivor set
              </p>
              <p className="text-muted">
                VWO&apos;s API returns only running and paused campaigns. The other 34
                (in the 286–369 range) are archived, stopped or draft and can&apos;t be
                pulled. Campaigns get archived when they&apos;re abandoned or
                misconfigured, so the invisible third is likely{" "}
                <span className="text-fg">worse than the visible two</span> — read every
                count here as a floor. Widening to 2023–26 holds the pattern: 158
                campaigns since Mar 2024, 8 conclusive (5%). 2026 isn&apos;t an off year,
                it&apos;s the norm.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Programme-level tracking caveat — the A/A test exposed asymmetric click capture. */}
      {experiments.length > 0 && (
        <section className="rounded-xl border border-warn/30 bg-warn/5 px-5 py-4">
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-0.5 shrink-0 text-warn">⚠</span>
            <div className="space-y-1.5 text-sm leading-relaxed">
              <p className="font-display font-semibold text-warn">
                Account-wide tracking caveat — read click metrics with suspicion
              </p>
              <p className="text-muted">
                The A/A test (316) returned a 0.01%-probability gap on a secondary
                click goal — impossible without asymmetric capture or bucketing, so{" "}
                <span className="text-fg">every click-tracked metric in the account inherits it</span>.
                Treat CTA-click and engagement goals as directional only; hang
                decisions on page-visit conversions until a fresh A/A clears it. GA
                and GTM are both disabled on the account, so nothing cross-checks VWO.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Error / empty states */}
      {loadError && (
        <div
          role="alert"
          className="rounded-xl border border-bad/30 bg-bad/10 px-5 py-4 text-sm text-bad"
        >
          Couldn&apos;t load the archive: {loadError}
        </div>
      )}

      {!loadError && experiments.length === 0 && (
        <div className="rounded-xl border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
          <p className="font-display text-lg font-semibold text-fg">
            No past experiments yet
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            Run the VWO import to bring every completed campaign — and its
            results — into the archive.
          </p>
          <Link
            href="/admin/import-vwo"
            className="mt-5 inline-block rounded-lg bg-accent px-5 py-2.5 font-display text-sm font-semibold text-bg transition-transform hover:-translate-y-0.5"
          >
            Import from VWO
          </Link>
        </div>
      )}

      {/* Experiment cards */}
      <div className="space-y-5">
        {experiments.map((exp) => (
          <article
            key={exp.key}
            className="overflow-hidden rounded-xl border border-line bg-surface"
          >
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0 space-y-1.5">
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
                  {(() => {
                    const fwd = exp.sourceId ? forward.get(exp.sourceId) : undefined;
                    if (!fwd) return null;
                    const scheduled = fwd.kind === "scheduled";
                    return (
                      <Link
                        href="/roadmap#tested-elements"
                        title={
                          scheduled
                            ? `Re-running as ${fwd.ticket || "a drafted ticket"}: ${fwd.title}`
                            : `Re-test candidate: ${fwd.proposedTitle}`
                        }
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide transition-colors ${
                          scheduled
                            ? "border-info/30 bg-info/10 text-info hover:border-info/60"
                            : "border-warn/30 bg-warn/10 text-warn hover:border-warn/60"
                        }`}
                      >
                        <span aria-hidden="true">→</span>
                        {scheduled ? "on the roadmap" : "re-test candidate"}
                      </Link>
                    );
                  })()}
                </div>
                <h2 className="font-display text-lg font-semibold text-fg">
                  <Link
                    href={`/archive/${exp.key}`}
                    className="transition-colors hover:text-accent"
                  >
                    {exp.name}
                  </Link>
                </h2>
                <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-faint">
                  <span>{dateRange(exp)}</span>
                  {exp.goalMetric && <span>goal · {exp.goalMetric}</span>}
                  <span className="uppercase">{exp.source}</span>
                </div>
              </div>
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
            </header>

            {exp.insight && (
              <div className="border-b border-line bg-accent/5 px-5 py-3">
                <p className="text-sm leading-relaxed text-fg">
                  <span className="mr-2 font-mono text-[10px] font-semibold uppercase tracking-wide text-accent">
                    Insight
                  </span>
                  {exp.insight}
                </p>
              </div>
            )}

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
                      <tr
                        key={v.key}
                        className={isWinner ? "bg-good/5" : undefined}
                      >
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

            {(exp.hypothesis || exp.notes) && (
              <footer className="border-t border-line px-5 py-3 text-xs leading-relaxed text-muted">
                {exp.hypothesis && (
                  <p>
                    <span className="font-mono uppercase tracking-wide text-faint">
                      Hypothesis ·{" "}
                    </span>
                    {exp.hypothesis}
                  </p>
                )}
                {exp.notes && (
                  <p className={exp.hypothesis ? "mt-1.5" : undefined}>
                    {exp.notes}
                  </p>
                )}
              </footer>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
