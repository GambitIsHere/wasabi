import Link from "next/link";
import { notFound } from "next/navigation";
import { YT, type RoadmapTest } from "@/lib/roadmap";
import { findRoadmapTestAsync } from "@/lib/roadmap-store";
import { LANE, STATUS } from "@/lib/roadmap-format";
import { listArchived, type ArchivedExperiment } from "@/lib/archive";
import { ArchivedRunDetail } from "@/components/archive/ArchivedRunDetail";

// DB-backed: the roadmap store + the archived run this test repeats both land in
// the DB, so render per request and degrade gracefully if a read fails.
export const dynamic = "force-dynamic";

/** A neighbour in the lane sequence — a link when it has a ticket, else plain. */
function Neighbour({ label, test }: { label: string; test: RoadmapTest }) {
  return (
    <span className="text-faint">
      {label}{" "}
      {test.ticket ? (
        <Link
          href={`/roadmap/${test.ticket}`}
          className="text-info transition-colors hover:text-accent hover:underline"
        >
          {test.ticket}
        </Link>
      ) : (
        <span className="text-muted">{test.title}</span>
      )}
    </span>
  );
}

export default async function RoadmapTestPage({
  params,
}: {
  params: Promise<{ ticket: string }>;
}) {
  const { ticket } = await params;
  const found = await findRoadmapTestAsync(ticket);
  if (!found) notFound();
  const { lane, test } = found;

  const laneCls = LANE[lane.lane];
  const status = STATUS[test.status];

  // Placement — where this test sits in its lane's serial sequence.
  const idx = lane.tests.findIndex((t) => t.ticket === test.ticket);
  const total = lane.tests.length;
  const prev = idx > 0 ? lane.tests[idx - 1] : null;
  const next = idx >= 0 && idx < total - 1 ? lane.tests[idx + 1] : null;

  // The archived run this test repeats (if any) — pulled whole so the evidence
  // (results, verdict, insight, payment read) renders inline. Degrades to just a
  // link when the DB is unreachable at request time.
  let archived: ArchivedExperiment | undefined;
  if (test.rerunOf) {
    try {
      archived = (await listArchived()).find((a) => a.sourceId === test.rerunOf);
    } catch {
      /* DB down — link the archive index instead of rendering the run inline. */
    }
  }
  const archiveHref = archived ? `/archive/${archived.key}` : "/archive";

  return (
    <div className="space-y-8">
      {/* 1. Back link */}
      <Link
        href="/roadmap"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-faint transition-colors hover:text-fg"
      >
        <span aria-hidden="true">←</span> Roadmap
      </Link>

      {/* 2. Header */}
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded bg-bg px-2 py-0.5 font-mono text-[10px]">
            <span className={`font-bold ${laneCls.text}`}>{lane.lane}</span>
            <span className="text-muted">{lane.business}</span>
          </span>
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide ${status.cls}`}
          >
            {status.label}
          </span>
          {test.pilot && (
            <span className="inline-flex items-center rounded-full border border-violet/30 bg-violet/10 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-violet">
              Optimiser.Pro pilot
            </span>
          )}
        </div>

        <h1 className="max-w-3xl font-display text-3xl font-bold tracking-tight text-fg sm:text-4xl">
          {test.title}
        </h1>

        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-faint">
          <span>{test.surface}</span>
          <span>
            W{test.startWeek}–{test.endWeek}
          </span>
          <span>{test.ticket}</span>
        </div>

        {test.note && (
          <p className="max-w-2xl text-sm leading-relaxed text-muted">{test.note}</p>
        )}
      </header>

      {/* 3. Placement — where this test sits in its lane. */}
      <section className="space-y-2">
        <p className="eyebrow">Placement</p>
        <div className="space-y-2.5 rounded-xl border border-line bg-surface px-5 py-4">
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-sm">
            <span className="text-muted">
              Step <span className="font-semibold text-fg">{idx + 1}</span> of {total}{" "}
              in the <span className={`font-semibold ${laneCls.text}`}>{lane.lane}</span>{" "}
              lane
            </span>
            <span className="text-muted">
              Runs{" "}
              <span className="font-medium text-fg">
                W{test.startWeek}–{test.endWeek}
              </span>
            </span>
          </div>
          <div className="font-mono text-[11px] text-faint">
            {lane.repo} · {lane.site}
          </div>
          {(prev || next) && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-2.5 font-mono text-[11px]">
              {prev && <Neighbour label="after" test={prev} />}
              {next && <Neighbour label="before" test={next} />}
            </div>
          )}
        </div>
      </section>

      {/* 4. YouTrack — the external ticket link lives inside the page. */}
      <section className="flex flex-wrap items-center gap-3">
        <a
          href={YT(test.ticket)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 py-2.5 font-display text-sm font-semibold text-fg transition-colors hover:border-accent/50 hover:text-accent"
        >
          YouTrack ticket <span aria-hidden="true">↗</span>
        </a>
        <span className="font-mono text-[11px] text-faint">
          {test.ticket} · sanjow.youtrack.cloud
        </span>
      </section>

      {/* 5. Evidence — the archived run this test repeats, rendered inline. */}
      {test.rerunOf && (
        <section className="space-y-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="eyebrow">
              <span aria-hidden="true" className="mr-1.5 text-info">
                ↩
              </span>
              Evidence — the run this repeats
            </p>
            <Link
              href={archiveHref}
              className="font-mono text-[11px] text-info transition-colors hover:text-accent hover:underline"
            >
              full archive <span aria-hidden="true">→</span>
            </Link>
          </div>

          {archived ? (
            <>
              <p className="max-w-2xl text-sm leading-relaxed text-muted">
                Repeats{" "}
                <span className="font-medium text-fg">{archived.name}</span>{" "}
                (#{test.rerunOf}, {archived.source.toUpperCase()}) — the same lever,
                a clean re-test. What that run found:
              </p>
              <ArchivedRunDetail exp={archived} compact />
            </>
          ) : (
            <p className="max-w-2xl text-sm leading-relaxed text-muted">
              This repeats an earlier run — the same lever, a clean re-test.{" "}
              <Link
                href={archiveHref}
                className="font-mono text-info transition-colors hover:text-accent hover:underline"
              >
                Campaign #{test.rerunOf} in the archive{" "}
                <span aria-hidden="true">→</span>
              </Link>
            </p>
          )}
        </section>
      )}
    </div>
  );
}
