// ============================================================================
// Backlog Suspense fallback — Next.js App Router loading.tsx.
// ----------------------------------------------------------------------------
// Shown while app/backlog/page.tsx does its live YouTrack fetch. Server
// component (no client JS needed for a static shimmer). Mirrors the real
// page's header — eyebrow, title, tab toggle, intro copy, and accent rule —
// plus a few groups of skeleton ticket rows shaped like TicketRow, so the
// layout doesn't jump when the real data swaps in.
// ============================================================================
export default function BacklogLoading() {
  return (
    <div className="space-y-8">
      <section className="relative space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-3">
            <p className="eyebrow">From YouTrack</p>
            <h1 className="font-display text-4xl font-bold tracking-tight text-fg sm:text-5xl">
              Test <span className="serif-accent">backlog</span>
            </h1>
          </div>
          {/* Open / All+history tab toggle placeholder. */}
          <div className="skeleton h-7 w-40 rounded-lg" aria-hidden="true" />
        </div>
        {/* Intro-copy placeholder — reserves the 3-line description height so
            the accent rule and rows don't shift up. */}
        <div className="max-w-3xl space-y-2" aria-hidden="true">
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-2/3" />
        </div>
        <div
          className="h-0.5 w-28 rounded-full bg-accent"
          aria-hidden="true"
        />
      </section>

      <section className="space-y-8" aria-hidden="true">
        <SkeletonGroup rows={3} />
        <SkeletonGroup rows={4} />
        <SkeletonGroup rows={2} />
      </section>
    </div>
  );
}

/** One business group: a label/count line + a card of skeleton rows. */
function SkeletonGroup({ rows }: { rows: number }) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline gap-2">
        <div className="skeleton h-3 w-24" />
        <div className="skeleton h-3 w-5" />
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {Array.from({ length: rows }, (_, i) => (
          <SkeletonRow key={i} />
        ))}
      </ul>
    </div>
  );
}

/** Shaped like TicketRow: state pill + id/summary line + a meta line. */
function SkeletonRow() {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="skeleton mt-0.5 h-4 w-12 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5 py-0.5">
        <div className="flex items-center gap-2">
          <div className="skeleton h-3 w-10" />
          <div className="skeleton h-3.5 w-2/3 max-w-xs" />
        </div>
        <div className="flex items-center gap-2">
          <div className="skeleton h-2.5 w-14" />
          <div className="skeleton h-2.5 w-20" />
        </div>
      </div>
    </li>
  );
}
