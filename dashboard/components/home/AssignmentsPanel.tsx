// Cockpit "ASSIGNMENTS TODAY" panel — today's assignment volume per business.
// Server component. Merges the live per-business counts (event store) with the
// full business roster so every business shows, even at zero. Counts scale a
// green bar to the busiest business; zero-traffic businesses read "no traffic".
import type { BusinessCount } from "@/lib/home";
import { BUSINESSES } from "@/lib/mgmt";

interface Row {
  business: string;
  count: number;
}

/** Merge live counts with the full roster; busiest first, then zeros by name. */
function buildRows(byBusiness: BusinessCount[]): Row[] {
  const counts = new Map<string, number>();
  for (const b of byBusiness) counts.set(b.business, b.count);
  // Every known business, plus any live business the roster doesn't list (e.g.
  // an "Unknown" bucket) so nothing captured is hidden.
  const names = new Set<string>([...BUSINESSES, ...counts.keys()]);
  return [...names]
    .map((business) => ({ business, count: counts.get(business) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.business.localeCompare(b.business));
}

export function AssignmentsPanel({
  byBusiness,
}: {
  byBusiness: BusinessCount[];
}) {
  const rows = buildRows(byBusiness);
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <section className="flex flex-col rounded-xl border border-line bg-surface">
      <header className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-fg">
          Assignments today
        </h2>
        <span className="font-mono text-xs text-faint">by business</span>
      </header>
      <ul className="divide-y divide-line-whisper">
        {rows.map((r) => {
          const has = r.count > 0;
          return (
            <li key={r.business} className="px-5 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className={`truncate text-sm ${has ? "text-fg" : "text-faint"}`}
                >
                  {r.business}
                </span>
                <span
                  className={`shrink-0 font-mono text-sm tabular-nums ${
                    has ? "text-fg" : "text-faint"
                  }`}
                >
                  {r.count}
                </span>
              </div>
              {has ? (
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-bg">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${Math.max(4, (r.count / max) * 100)}%` }}
                  />
                </div>
              ) : (
                <p className="mt-0.5 font-mono text-[11px] text-faint">
                  no traffic
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="border-t border-line-whisper px-5 py-2.5 text-[11px] leading-relaxed text-faint">
        Assignments come from storefront capture (not yet wired); the payment P&amp;L
        is measured from the payments DB, so money can move while this reads zero.
      </p>
    </section>
  );
}
