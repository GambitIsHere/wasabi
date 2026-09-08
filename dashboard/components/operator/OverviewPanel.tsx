// Overview tab — a KPI strip + two mix bars + a per-org ranking, all DOM/CSS
// (no chart library, per the tool's convention). Hook-free, so it renders
// happily inside the client console. Every colour is a Signal token, so both
// themes are covered by globals.css.
import type { OrgSummary, PlatformOverview } from "@/lib/platform-types";

function KpiCard({
  label,
  value,
  sub,
  valueClass = "text-fg",
}: {
  label: string;
  value: string;
  sub: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <p className="eyebrow">{label}</p>
      <p className={`mt-2 font-display text-3xl font-bold tabular-nums ${valueClass}`}>{value}</p>
      <p className="mt-1.5 text-xs text-faint">{sub}</p>
    </div>
  );
}

interface Segment {
  label: string;
  value: number;
  /** A background utility token, e.g. "bg-good". */
  color: string;
}

/** A stacked proportion bar + legend. Segments with value 0 are dropped from
 *  the bar but still shown in the legend so the reader sees the full taxonomy. */
function MixBar({ title, segments }: { title: string; segments: Segment[] }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <p className="eyebrow">{title}</p>
      <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-bg" role="img" aria-label={title}>
        {total === 0 ? (
          <div className="h-full w-full bg-line" />
        ) : (
          segments
            .filter((seg) => seg.value > 0)
            .map((seg) => (
              <div
                key={seg.label}
                className={seg.color}
                style={{ width: `${(seg.value / total) * 100}%` }}
                title={`${seg.label}: ${seg.value}`}
              />
            ))
        )}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((seg) => (
          <li key={seg.label} className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
            <span className={`size-2 rounded-full ${seg.color}`} aria-hidden="true" />
            {seg.label}
            <span className="tabular-nums text-fg">{seg.value.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Horizontal bar ranking — orgs by live experiment count, top 6. */
function OrgRanking({ orgs }: { orgs: OrgSummary[] }) {
  const top = [...orgs]
    .sort((a, b) => b.liveExperimentCount - a.liveExperimentCount || b.memberCount - a.memberCount)
    .slice(0, 6);
  const max = Math.max(1, ...top.map((o) => o.liveExperimentCount));

  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <p className="eyebrow">Organizations by live tests</p>
      {top.length === 0 ? (
        <p className="mt-3 text-sm text-faint">No organizations yet.</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {top.map((o) => (
            <li key={o.id} className="flex items-center gap-3">
              <span className="w-28 shrink-0 truncate text-sm text-fg" title={o.name}>
                {o.name}
              </span>
              <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-bg">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-accent"
                  style={{ width: `${(o.liveExperimentCount / max) * 100}%` }}
                />
              </span>
              <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-muted">
                {o.liveExperimentCount}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function OverviewPanel({
  overview,
  orgs,
}: {
  overview: PlatformOverview;
  orgs: OrgSummary[];
}) {
  const pausedLive = Math.max(0, overview.liveExperiments - overview.activeExperiments);
  return (
    <div className="space-y-6">
      <section aria-label="Platform KPIs" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard
          label="Organizations"
          value={overview.orgs.toLocaleString()}
          sub={`${overview.projects.toLocaleString()} projects`}
        />
        <KpiCard
          label="Members"
          value={overview.members.toLocaleString()}
          sub={`${overview.activeUsers} active · ${overview.pendingUsers} pending`}
        />
        <KpiCard
          label="Live tests"
          value={overview.liveExperiments.toLocaleString()}
          valueClass={overview.activeExperiments > 0 ? "text-accent" : "text-fg"}
          sub={`${overview.activeExperiments} running · ${pausedLive} paused`}
        />
        <KpiCard
          label="Archived tests"
          value={overview.archivedExperiments.toLocaleString()}
          sub="imported history"
        />
        <KpiCard
          label="Events captured"
          value={overview.events.toLocaleString()}
          sub={`${overview.eventsToday.toLocaleString()} today`}
        />
      </section>

      <section aria-label="Platform mix" className="grid gap-3 lg:grid-cols-2">
        <MixBar
          title="Members by account status"
          segments={[
            { label: "active", value: overview.activeUsers, color: "bg-good" },
            { label: "pending", value: overview.pendingUsers, color: "bg-warn" },
            { label: "suspended", value: overview.suspendedUsers, color: "bg-bad" },
          ]}
        />
        <MixBar
          title="Experiments by state"
          segments={[
            { label: "running", value: overview.activeExperiments, color: "bg-accent" },
            { label: "paused", value: pausedLive, color: "bg-faint" },
            { label: "archived", value: overview.archivedExperiments, color: "bg-info" },
          ]}
        />
      </section>

      <OrgRanking orgs={orgs} />
    </div>
  );
}
