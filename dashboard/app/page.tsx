import Link from "next/link";
import { getExperiments } from "@/lib/experiments";
import { StatusPill } from "@/components/pills";
import { ExperimentControls } from "@/components/ExperimentControls";

// DB-backed list — re-read on every request so create/edit/toggle/delete reflect
// immediately (also revalidated by the actions).
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const experiments = await getExperiments();

  return (
    <div className="space-y-8">
      {/* Intro + New */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">
            Experiments
          </h1>
          <Link
            href="/experiments/new"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg transition-opacity hover:opacity-90"
          >
            + New experiment
          </Link>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          <span className="font-medium text-fg">Wasabi</span> is Sanjow&apos;s
          in-house experimentation engine — PostHog-compatible. It assigns each
          visitor a sticky variant with a storage-free SHA-1 hash (the same user
          always lands in the same arm, on any machine, with no DB lookup), then
          ties every arm back to its real payment P&amp;L to deliver a verdict:
          which variant actually made more money per acquired customer, and
          whether the difference is statistically real.
        </p>
      </section>

      {/* Experiment cards */}
      {experiments.length === 0 ? (
        <EmptyState />
      ) : (
        <section
          aria-label="Registered experiments"
          className="grid gap-4 sm:grid-cols-2"
        >
          {experiments.map((exp) => {
            const variants = exp.flag.variants ?? [];
            return (
              <article
                key={exp.flag.key}
                className="flex flex-col rounded-xl border border-line bg-surface p-5 transition-colors hover:border-line-strong"
              >
                <div className="flex items-start justify-between gap-3">
                  <Link
                    href={`/experiments/${exp.flag.key}`}
                    className="group min-w-0 focus:outline-none"
                  >
                    <h2 className="truncate text-base font-semibold text-fg group-hover:text-accent">
                      {exp.name}
                    </h2>
                    <code className="mt-0.5 block truncate font-mono text-xs text-faint">
                      {exp.flag.key}
                    </code>
                  </Link>
                  <StatusPill active={exp.flag.active} />
                </div>

                <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-muted">
                  {exp.description}
                </p>

                {/* Traffic split */}
                <div className="mt-4">
                  <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-faint">
                    <span>Traffic split</span>
                    <span>{exp.flag.rolloutPercentage}% rollout</span>
                  </div>
                  <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg">
                    {variants.map((v, i) => (
                      <div
                        key={v.key}
                        className={i % 2 === 0 ? "bg-accent-soft" : "bg-info/70"}
                        style={{ width: `${v.rolloutPercentage}%` }}
                        title={`${v.key}: ${v.rolloutPercentage}%`}
                      />
                    ))}
                  </div>
                </div>

                {/* Variants → theme */}
                <ul className="mt-4 space-y-1.5 text-sm">
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
                          <span className="text-[10px] font-medium uppercase text-info">
                            ctrl
                          </span>
                        )}
                        <span className="text-faint">·</span>
                        <span className="tabular-nums text-faint">
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
                <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
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
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-surface px-6 py-16 text-center">
      <div className="mb-3 text-3xl" aria-hidden="true">
        🌶
      </div>
      <h2 className="text-lg font-semibold text-fg">No experiments yet</h2>
      <p className="mt-1.5 max-w-sm text-sm text-muted">
        Create your first experiment to start assigning variants and measuring
        the payment-P&amp;L verdict.
      </p>
      <Link
        href="/experiments/new"
        className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg transition-opacity hover:opacity-90"
      >
        + New experiment
      </Link>
    </div>
  );
}
