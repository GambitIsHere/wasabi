// ============================================================================
// Roadmap Suspense fallback — Next.js App Router loading.tsx.
// ----------------------------------------------------------------------------
// Shown while app/roadmap/page.tsx reads the DB-backed roadmap + archive. Paints
// the runway's shape immediately — the header, a lane×week grid of skeleton
// cells with a couple of tile bars, and a settled-elements table — so a click
// onto Roadmap feels instant and the layout doesn't jump when data swaps in.
// Server component; static shimmer, no client JS.
// ============================================================================
const WEEKS = 10;
const LANES = 4;

export default function RoadmapLoading() {
  return (
    <div className="space-y-10" aria-hidden="true">
      <section className="space-y-3">
        <div className="skeleton h-3 w-24" />
        <div className="skeleton h-11 w-72 max-w-full rounded-lg" />
        <div className="max-w-2xl space-y-2 pt-1">
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-3/4" />
        </div>
      </section>

      <section className="space-y-3">
        <div className="skeleton h-3 w-28" />
        <div className="overflow-x-auto rounded-xl border border-line bg-surface p-4">
          <div
            className="grid min-w-[760px] gap-x-1.5 gap-y-2.5"
            style={{ gridTemplateColumns: `128px repeat(${WEEKS}, minmax(0,1fr))` }}
          >
            {/* Week header */}
            <div style={{ gridRow: 1, gridColumn: 1 }} />
            {Array.from({ length: WEEKS }, (_, w) => (
              <div key={w} style={{ gridRow: 1, gridColumn: w + 2 }} className="flex justify-center pb-1">
                <div className="skeleton h-2.5 w-5" />
              </div>
            ))}
            {/* Lane rows: a label + a single wide tile bar per lane */}
            {Array.from({ length: LANES }, (_, li) => (
              <div key={`row-${li}`} style={{ display: "contents" }}>
                <div style={{ gridRow: li + 2, gridColumn: 1 }} className="flex flex-col justify-center gap-1 pr-2">
                  <div className="skeleton h-4 w-8" />
                  <div className="skeleton h-2 w-16" />
                </div>
                <div
                  style={{ gridRow: li + 2, gridColumn: `2 / ${Math.min(4 + li * 2, WEEKS + 1) + 1}` }}
                  className="skeleton h-12 rounded-lg"
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="skeleton h-3 w-28" />
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 border-b border-line px-5 py-3 last:border-0">
              <div className="skeleton h-3.5 w-1/4" />
              <div className="skeleton h-3 w-12" />
              <div className="skeleton h-5 w-20 rounded-full" />
              <div className="skeleton h-3 w-1/3" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
