// ============================================================================
// Tickets Suspense fallback — Next.js App Router loading.tsx.
// ----------------------------------------------------------------------------
// Shown while app/tickets/page.tsx reads the DB. Paints the board's shape — the
// header plus four column shells with a few card skeletons — so navigating to
// Tickets feels instant and the layout doesn't jump when data swaps in. Server
// component; static shimmer, no client JS. Mirrors app/roadmap/loading.tsx.
// ============================================================================
const CARDS_PER_COLUMN = [3, 2, 2, 1];

export default function TicketsLoading() {
  return (
    <div className="space-y-8" aria-hidden="true">
      <section className="space-y-3">
        <div className="skeleton h-3 w-24" />
        <div className="skeleton h-11 w-64 max-w-full rounded-lg" />
        <div className="max-w-2xl space-y-2 pt-1">
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-2/3" />
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {CARDS_PER_COLUMN.map((cards, c) => (
          <div key={c} className="flex flex-col rounded-xl border border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="skeleton h-4 w-16" />
              <div className="skeleton h-4 w-5" />
            </div>
            <div className="flex flex-col gap-2 p-3">
              {Array.from({ length: cards }, (_, i) => (
                <div
                  key={i}
                  className="space-y-2 rounded-lg border border-line-strong bg-bg px-3 py-2.5"
                >
                  <div className="skeleton h-4 w-5/6" />
                  <div className="skeleton h-4 w-1/3 rounded-full" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
