// Compact wiring / health panel for one experiment's detail page. Server-safe
// (no client hooks) so it renders inside the server component. Reads ONLY the
// local event store (via lib/events.experimentWiring) — no Metabase — so it
// degrades to a clean "not wired yet" state whenever there are no events.
import type { ExperimentWiring, WiringCounts } from "@/lib/events";
import { ControlBadge } from "@/components/pills";

const ZERO: WiringCounts = {
  assignmentsToday: 0,
  assignmentsTotal: 0,
  capturesToday: 0,
  capturesTotal: 0,
};

/** One "today / total" figure pair. */
function CountCell({ today, total }: { today: number; total: number }) {
  return (
    <span className="tabular-nums">
      <span className="text-fg">{today}</span>
      <span className="text-faint"> / {total}</span>
    </span>
  );
}

function StatTile({
  label,
  today,
  total,
  hint,
}: {
  label: string;
  today: number;
  total: number;
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-bg px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
        {label}
      </p>
      <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-fg">
        {today.toLocaleString()}
        <span className="ml-1.5 align-baseline text-sm font-normal text-faint">
          today
        </span>
      </p>
      <p className="mt-0.5 text-[11px] text-faint">
        {total.toLocaleString()} total · {hint}
      </p>
    </div>
  );
}

export function ExperimentHealth({
  wiring,
  variants,
  controlVariant,
}: {
  wiring: ExperimentWiring;
  /** The experiment's declared arms — so a zero-traffic arm still renders. */
  variants: { key: string }[];
  controlVariant: string;
}) {
  const receiving = wiring.assignmentsTotal > 0;

  return (
    <section className="rounded-xl border border-line bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div>
          <h2 className="font-display text-sm font-semibold text-fg">
            Wiring &amp; health
          </h2>
          <p className="mt-0.5 text-xs text-faint">
            Assignments confirm visitors are being bucketed; goal captures
            confirm the goal event reaches Wasabi.
          </p>
        </div>
        {receiving ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-good/30 bg-good/10 px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-good">
            <span className="size-1.5 rounded-full bg-good" aria-hidden="true" />
            Receiving traffic
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-warn/40 bg-warn/10 px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-warn">
            <span className="size-1.5 rounded-full bg-warn" aria-hidden="true" />
            Not wired yet
          </span>
        )}
      </header>

      {!receiving && (
        <p className="border-b border-line px-5 py-3 text-xs text-muted">
          No assignments captured yet. Once the storefront middleware routes
          traffic through this experiment, assignments and goal captures land
          here. Use the assignment tester below to fire a sample event.
        </p>
      )}

      <div className="grid gap-3 p-5 sm:grid-cols-2">
        <StatTile
          label="Assignments"
          today={wiring.assignmentsToday}
          total={wiring.assignmentsTotal}
          hint="visitors bucketed into an arm"
        />
        <StatTile
          label="Goal captures"
          today={wiring.capturesToday}
          total={wiring.capturesTotal}
          hint="goal / conversion events received"
        />
      </div>

      <div className="overflow-x-auto border-t border-line">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="text-left font-mono text-[11px] uppercase tracking-wider text-muted">
              <th className="px-5 py-2.5 font-medium">Arm</th>
              <th className="px-3 py-2.5 text-right font-medium">
                Assignments (today / total)
              </th>
              <th className="px-5 py-2.5 text-right font-medium">
                Captures (today / total)
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {variants.map((v) => {
              const c = wiring.byArm[v.key] ?? ZERO;
              return (
                <tr key={v.key} className="hover:bg-surface-hover">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-fg">
                        {v.key}
                      </span>
                      {v.key === controlVariant && <ControlBadge />}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right text-muted">
                    <CountCell today={c.assignmentsToday} total={c.assignmentsTotal} />
                  </td>
                  <td className="px-5 py-3 text-right text-muted">
                    <CountCell today={c.capturesToday} total={c.capturesTotal} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="border-t border-line px-5 py-3 text-[11px] text-faint">
        Counts are from the assignment event store (7-day window). Payment
        results come from Metabase — see the verdict below.
      </p>
    </section>
  );
}
