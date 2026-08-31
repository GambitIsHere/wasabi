// Cockpit KPI strip — four flat metric cards. Server component (no interactivity).
// Assignment KPIs come from the event store (live locally); the money KPIs come
// from Metabase and read £0.00 when it's unavailable — rendered plainly, not as a
// "good" figure, so a local £0 doesn't look like a win.
import Link from "next/link";
import type { HomeMetrics } from "@/lib/home";

function gbp(n: number): string {
  return `£${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

interface KpiCardProps {
  label: string;
  value: string;
  /** Value colour token — defaults to primary text. */
  valueClass?: string;
  sub: React.ReactNode;
}

function KpiCard({ label, value, valueClass = "text-fg", sub }: KpiCardProps) {
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <p className="eyebrow">{label}</p>
      <p
        className={`mt-2 font-display text-3xl font-bold tabular-nums ${valueClass}`}
      >
        {value}
      </p>
      <p className="mt-1.5 text-xs text-faint">{sub}</p>
    </div>
  );
}

export function KpiStrip({ metrics }: { metrics: HomeMetrics }) {
  const withTraffic = metrics.byBusiness.filter((b) => b.count > 0).length;
  const collected = metrics.collectedTodayGBP;

  return (
    <section
      aria-label="Key metrics"
      className="grid grid-cols-2 gap-3 lg:grid-cols-4"
    >
      <KpiCard
        label="Active tests"
        value={String(metrics.activeTests)}
        sub={`${metrics.queuedTests} queued`}
      />
      <KpiCard
        label="Assignments today"
        value={metrics.assignmentsToday.toLocaleString()}
        sub={
          withTraffic > 0
            ? `${withTraffic} ${withTraffic === 1 ? "business" : "businesses"} with traffic`
            : "no traffic yet today"
        }
      />
      <KpiCard
        label="Collected today"
        value={gbp(collected)}
        valueClass={collected > 0 ? "text-good" : "text-fg"}
        sub={`${metrics.authToday} auth · ${metrics.rebillToday} rebill`}
      />
      <KpiCard
        label="Awaiting a call"
        value={String(metrics.awaitingCall)}
        valueClass={metrics.awaitingCall > 0 ? "text-warn" : "text-fg"}
        sub={
          <Link
            href="/backlog"
            className="text-faint underline-offset-2 transition-colors hover:text-accent hover:underline"
          >
            decision inbox
          </Link>
        }
      />
    </section>
  );
}
