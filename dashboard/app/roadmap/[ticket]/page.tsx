import Link from "next/link";
import { notFound } from "next/navigation";
import { findRoadmapTest, YT } from "@/lib/roadmap";
import { LANE, STATUS } from "@/lib/roadmap-format";
import { listArchived } from "@/lib/archive";

// A re-run caption deep-links into the archive by `key` — known only from the DB
// — so render per request (the archive import lands here) and degrade to the
// archive index if the DB isn't reachable. Same posture as /roadmap and /archive.
export const dynamic = "force-dynamic";

export default async function RoadmapTestPage({
  params,
}: {
  params: Promise<{ ticket: string }>;
}) {
  const { ticket } = await params;
  const found = findRoadmapTest(ticket);
  if (!found) notFound();
  const { lane, test } = found;

  const laneCls = LANE[lane.lane];
  const status = STATUS[test.status];

  // Resolve a re-run's VWO campaign sourceId → archive `key` for the deep link,
  // falling back to the archive index when the DB is down at request time.
  let archiveHref = "/archive";
  if (test.rerunOf) {
    try {
      const match = (await listArchived()).find(
        (a) => a.sourceId === test.rerunOf,
      );
      if (match) archiveHref = `/archive/${match.key}`;
    } catch {
      /* DB down — link the archive index instead of the specific run. */
    }
  }

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
              Wasabi pilot
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
          <p className="max-w-2xl text-sm leading-relaxed text-muted">
            {test.note}
          </p>
        )}
      </header>

      {/* 3. YouTrack — the external ticket link now lives inside the page. */}
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

      {/* 4. Re-run provenance — the archived run this test repeats. */}
      {test.rerunOf && (
        <section className="rounded-xl border border-info/25 bg-info/5 px-5 py-4">
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-0.5 shrink-0 text-info">
              ↩
            </span>
            <div className="space-y-1.5 text-sm leading-relaxed">
              <p className="font-display font-semibold text-info">
                Re-runs a past test
              </p>
              <p className="text-muted">
                This repeats an earlier run from the archive — the same lever, a
                clean re-test.{" "}
                <Link
                  href={archiveHref}
                  className="font-mono text-info transition-colors hover:text-accent hover:underline"
                >
                  Campaign #{test.rerunOf} in the archive{" "}
                  <span aria-hidden="true">→</span>
                </Link>
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
