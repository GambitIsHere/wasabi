import Link from "next/link";
import { notFound } from "next/navigation";
import { getArchived, type ArchivedExperiment } from "@/lib/archive";
import { STATUS, fmtDate } from "@/lib/archive-format";
import { ArchivedRunDetail } from "@/components/archive/ArchivedRunDetail";

// DB-backed — resolve each archived key on request (routes aren't known at build).
export const dynamic = "force-dynamic";

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
            Winner — <span className="font-medium text-good">{winner.name}</span>{" "}
            took the run.
          </p>
        )}
      </header>

      {/* 3. The run body — insight · KPIs · chart · results · payment · notes. */}
      <ArchivedRunDetail exp={exp} />
    </div>
  );
}
