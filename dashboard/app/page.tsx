import Link from "next/link";
import { getExperiments } from "@/lib/experiments";
import { StatusPill } from "@/components/pills";

export default function HomePage() {
  const experiments = getExperiments();

  return (
    <div className="space-y-8">
      {/* Intro */}
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          Experiments
        </h1>
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
      <section
        aria-label="Registered experiments"
        className="grid gap-4 sm:grid-cols-2"
      >
        {experiments.map((exp) => {
          const variants = exp.flag.variants ?? [];
          return (
            <Link
              key={exp.flag.key}
              href={`/experiments/${exp.flag.key}`}
              className="group flex flex-col rounded-xl border border-line bg-surface p-5 transition-colors hover:border-line-strong hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-fg group-hover:text-accent">
                    {exp.name}
                  </h2>
                  <code className="mt-0.5 block truncate font-mono text-xs text-faint">
                    {exp.flag.key}
                  </code>
                </div>
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
                      className={
                        i % 2 === 0 ? "bg-accent-soft" : "bg-info/70"
                      }
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

              <span className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-faint transition-colors group-hover:text-accent">
                View detail &amp; verdict
                <span aria-hidden="true">→</span>
              </span>
            </Link>
          );
        })}
      </section>
    </div>
  );
}
