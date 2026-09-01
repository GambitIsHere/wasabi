// ============================================================================
// Root Suspense fallback — Next.js App Router loading.tsx.
// ----------------------------------------------------------------------------
// Shown the instant you navigate to any route that doesn't ship its own
// loading.tsx (home, archive, experiments, …), so a click paints immediately
// instead of waiting on the server render + live DB/Metabase queries. A route
// with its own loading.tsx (roadmap, backlog) overrides this one. Server
// component — a static shimmer needs no client JS.
//
// Deliberately generic: a header block + a KPI strip + a couple of card grids,
// the shape most pages share. It only has to hold attention for a beat, not
// pixel-match every page.
// ============================================================================
export default function Loading() {
  return (
    <div className="space-y-8" aria-hidden="true">
      <section className="space-y-3">
        <div className="skeleton h-3 w-24" />
        <div className="skeleton h-11 w-72 max-w-full rounded-lg" />
        <div className="max-w-2xl space-y-2 pt-1">
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-2/3" />
        </div>
      </section>

      {/* KPI strip */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-2 rounded-xl border border-line bg-surface p-4">
            <div className="skeleton h-3 w-16" />
            <div className="skeleton h-7 w-24" />
            <div className="skeleton h-2.5 w-20" />
          </div>
        ))}
      </section>

      {/* Card grid */}
      <section className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-xl border border-line bg-surface p-5">
            <div className="flex items-center gap-2">
              <div className="skeleton h-4 w-12" />
              <div className="skeleton h-3.5 w-1/2" />
            </div>
            <div className="skeleton h-3 w-full" />
            <div className="skeleton h-3 w-4/5" />
            <div className="flex gap-1.5 pt-1">
              <div className="skeleton h-5 w-16 rounded-full" />
              <div className="skeleton h-5 w-14 rounded-full" />
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
