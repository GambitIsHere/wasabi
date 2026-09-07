import Link from "next/link";
import { notFound } from "next/navigation";
import { getExperiment } from "@/lib/experiments";
import { youtrackTicketHref } from "@/lib/mgmt";
import { experimentWiring, EMPTY_WIRING, type ExperimentWiring } from "@/lib/events";
import { StatusPill, ControlBadge } from "@/components/pills";
import { AssignmentTester } from "@/components/AssignmentTester";
import { ExperimentHealth } from "@/components/ExperimentHealth";
import { LiveResults } from "@/components/LiveResults";
import { ExperimentControls } from "@/components/ExperimentControls";

// DB-backed — render dynamically so newly-created experiments resolve and edits
// reflect immediately (routes are no longer known at build time).
export const dynamic = "force-dynamic";

export default async function ExperimentDetailPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const experiment = await getExperiment(key);
  if (!experiment) notFound();

  const variants = experiment.flag.variants ?? [];

  // YouTrack ticket link — a bare ID resolves against YOUTRACK_BASE_URL, a full
  // URL is used as-is; null (no ticket) hides the link (degrade gracefully).
  const ytBase = process.env.YOUTRACK_BASE_URL || "https://sanjow.youtrack.cloud";
  const ticketHref = youtrackTicketHref(experiment.youtrackTicket, ytBase);

  // Wiring health reads the local event store only (no Metabase). Guard it so a
  // DB hiccup — or no DATABASE_URL locally — degrades to the empty state rather
  // than taking down the whole detail page.
  let wiring: ExperimentWiring = EMPTY_WIRING;
  try {
    wiring = await experimentWiring(experiment.flag.key);
  } catch {
    wiring = EMPTY_WIRING;
  }

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-faint transition-colors hover:text-fg"
      >
        <span aria-hidden="true">←</span> All experiments
      </Link>

      {/* 1. Header */}
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="eyebrow">Experiment</p>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-3xl font-bold tracking-tight text-fg">
                {experiment.name}
              </h1>
              <StatusPill active={experiment.flag.active} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/experiments/${experiment.flag.key}/edit`}
              className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-muted transition-colors hover:border-accent/40 hover:text-accent"
            >
              Edit
            </Link>
            <ExperimentControls
              experimentKey={experiment.flag.key}
              active={experiment.flag.active}
              variant="header"
              redirectOnDelete="/"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
          <span className="font-mono text-muted">{experiment.flag.key}</span>
          <span>·</span>
          <span>
            Started{" "}
            <time dateTime={experiment.startDate} className="text-muted">
              {experiment.startDate}
            </time>
          </span>
          <span>·</span>
          <span>
            Control{" "}
            <code className="font-mono text-muted">
              {experiment.controlVariant}
            </code>
          </span>
          {ticketHref && (
            <>
              <span>·</span>
              <a
                href={ticketHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-info transition-colors hover:text-accent"
                title="Open the YouTrack ticket"
              >
                Ticket <span aria-hidden="true">↗</span>
              </a>
            </>
          )}
        </div>
        {experiment.description && (
          <p className="max-w-3xl text-sm leading-relaxed text-muted">
            {experiment.description}
          </p>
        )}
      </header>

      {/* 2. Variants table */}
      <section className="rounded-xl border border-line bg-surface">
        <header className="border-b border-line px-5 py-3">
          <h2 className="font-display text-sm font-semibold text-fg">
            Variants
          </h2>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-left font-mono text-[11px] uppercase tracking-wider text-muted">
                <th className="px-5 py-2.5 font-medium">Variant</th>
                <th className="px-3 py-2.5 text-right font-medium">Weight</th>
                <th className="px-5 py-2.5 font-medium">Theme route</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {variants.map((v) => {
                const theme = experiment.themeMap[v.key];
                const isControl = v.key === experiment.controlVariant;
                return (
                  <tr key={v.key} className="hover:bg-surface-hover">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-fg">
                          {v.key}
                        </span>
                        {isControl && <ControlBadge />}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted">
                      {v.rolloutPercentage}%
                    </td>
                    <td className="px-5 py-3">
                      {theme ? (
                        <code className="font-mono text-xs text-accent/90">
                          ?theme={theme}
                        </code>
                      ) : (
                        <span className="text-xs text-faint">default</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* 3. Wiring / health — is it receiving assignments + goal captures yet? */}
      <ExperimentHealth
        wiring={wiring}
        variants={variants}
        controlVariant={experiment.controlVariant}
      />

      {/* 4. Assignment tester (client) */}
      <AssignmentTester
        experimentKey={experiment.flag.key}
        sampleId="user_42"
      />

      {/* 5. Live results + verdict (client, with loading/empty/error states) */}
      <section className="space-y-4">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight text-fg">
            Live results &amp; verdict
          </h2>
          <p className="mt-1 text-sm text-muted">
            Per-variant payment P&amp;L tied back to each arm, with a
            two-proportion significance test and a ship / keep-running call.
          </p>
        </div>
        <LiveResults experimentKey={experiment.flag.key} />
      </section>
    </div>
  );
}
