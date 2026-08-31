import Link from "next/link";
import { getExperiments } from "@/lib/experiments";
import { StatusPill } from "@/components/pills";
import { ExperimentControls } from "@/components/ExperimentControls";

// DB-backed list — re-read on every request so create/edit/toggle/delete reflect
// immediately (also revalidated by the actions).
export const dynamic = "force-dynamic";

// Per-variant bar colours from the editorial palette.
const VARIANT_BARS = [
  "bg-accent",
  "bg-info",
  "bg-violet",
  "bg-pink",
  "bg-amber",
  "bg-sky",
];

export default async function HomePage() {
  const experiments = await getExperiments();

  return (
    <div className="space-y-10">
      {/* Intro + New */}
      <section className="relative">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-3">
            <p className="eyebrow">Live experiments</p>
            <h1 className="font-display text-4xl font-bold tracking-tight text-fg sm:text-5xl">
              Every test, one <span className="serif-accent">verdict</span>.
            </h1>
          </div>
          <Link href="/experiments/new" className="btn-primary">
            + New experiment
          </Link>
        </div>
        <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted">
          <span className="font-medium text-fg">Wasabi</span> is Sanjow&apos;s
          in-house experimentation engine — PostHog-compatible. It assigns each
          visitor a sticky variant with a storage-free SHA-1 hash (the same user
          always lands in the same arm, on any machine, with no DB lookup), then
          ties every arm back to its real payment P&amp;L to deliver a verdict:
          which variant actually made more money per acquired customer, and
          whether the difference is statistically real.
        </p>
        <div
          className="mt-6 h-0.5 w-28 rounded-full bg-accent"
          aria-hidden="true"
        />
      </section>

      {/* Experiment cards */}
      {experiments.length === 0 ? (
        <EmptyState />
      ) : (
        <section
          aria-label="Registered experiments"
          className="grid gap-4 sm:grid-cols-2"
        >
          {experiments.map((exp, i) => {
            const variants = exp.flag.variants ?? [];
            return (
              <article
                key={exp.flag.key}
                className="card-clickable group relative flex flex-col overflow-hidden rounded-xl border border-line bg-bg-deep p-5"
              >
                {/* Oversized faded index — editorial signature. */}
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -right-1 top-1 font-display text-6xl font-bold tabular-nums text-accent/[0.07]"
                >
                  {String(i + 1).padStart(2, "0")}
                </span>

                <div className="relative flex items-start justify-between gap-3">
                  <Link
                    href={`/experiments/${exp.flag.key}`}
                    className="min-w-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-deep"
                  >
                    <h2 className="truncate font-display text-base font-semibold text-fg transition-colors group-hover:text-accent">
                      {exp.name}
                    </h2>
                    <code className="mt-0.5 block truncate font-mono text-xs text-faint">
                      {exp.flag.key}
                    </code>
                  </Link>
                  <StatusPill active={exp.flag.active} />
                </div>

                <p className="relative mt-3 line-clamp-2 text-sm leading-relaxed text-muted">
                  {exp.description}
                </p>

                {/* Traffic split */}
                <div className="relative mt-4">
                  <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] font-medium uppercase tracking-wider text-muted">
                    <span>Traffic split</span>
                    <span className="text-muted">
                      {exp.flag.rolloutPercentage}% rollout
                    </span>
                  </div>
                  <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg">
                    {variants.map((v, vi) => (
                      <div
                        key={v.key}
                        className={VARIANT_BARS[vi % VARIANT_BARS.length]}
                        style={{ width: `${v.rolloutPercentage}%` }}
                        title={`${v.key}: ${v.rolloutPercentage}%`}
                      />
                    ))}
                  </div>
                </div>

                {/* Variants → theme */}
                <ul className="relative mt-4 space-y-1.5 text-sm">
                  {variants.map((v) => {
                    const theme = exp.themeMap[v.key];
                    const isControl = v.key === exp.controlVariant;
                    return (
                      <li
                        key={v.key}
                        className="flex items-center gap-2 text-muted"
                      >
                        <span className="font-mono text-xs text-fg">{v.key}</span>
                        {isControl && (
                          <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-info">
                            ctrl
                          </span>
                        )}
                        <span className="text-faint">·</span>
                        <span className="font-mono tabular-nums text-faint">
                          {v.rolloutPercentage}%
                        </span>
                        {theme && (
                          <>
                            <span className="text-faint">→</span>
                            <code className="font-mono text-xs text-accent/90">
                              ?theme={theme}
                            </code>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>

                {/* Footer: detail link + controls */}
                <div className="relative mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
                  <div className="flex items-center gap-3 text-xs font-medium">
                    <Link
                      href={`/experiments/${exp.flag.key}`}
                      className="inline-flex items-center gap-1 text-faint transition-colors hover:text-accent"
                    >
                      Detail &amp; verdict
                      <span aria-hidden="true">→</span>
                    </Link>
                    <Link
                      href={`/experiments/${exp.flag.key}/edit`}
                      className="text-faint transition-colors hover:text-fg"
                    >
                      Edit
                    </Link>
                  </div>
                  <ExperimentControls
                    experimentKey={exp.flag.key}
                    active={exp.flag.active}
                    variant="card"
                  />
                </div>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-bg-deep px-6 py-16 text-center">
      <div className="mb-3 text-3xl" aria-hidden="true">
        🌶
      </div>
      <h2 className="font-display text-lg font-semibold text-fg">
        No experiments yet
      </h2>
      <p className="mt-1.5 max-w-sm text-sm text-muted">
        Create your first experiment to start assigning variants and measuring
        the payment-P&amp;L verdict.
      </p>
      <Link href="/experiments/new" className="btn-primary mt-5">
        + New experiment
      </Link>
    </div>
  );
}
