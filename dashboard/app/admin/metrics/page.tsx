import Link from "next/link";
import { listMetricsUncached } from "@/lib/metrics";
import { MetricsAdmin } from "@/components/metrics/MetricsAdmin";

// Auth-gated by middleware (path not in PUBLIC_PREFIXES — see middleware.ts).
// Uncached read (listMetricsUncached, not getMetrics) so a create/edit/toggle/
// delete on this page is reflected the moment router.refresh() re-runs this
// server component — same reasoning lib/metrics.ts gives for the cached/
// uncached split (getMetrics is the hot verdict-computation path; this is not it).
export const dynamic = "force-dynamic";

export default async function MetricsAdminPage() {
  const metrics = await listMetricsUncached();

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-faint transition-colors hover:text-fg"
        >
          <span aria-hidden="true">←</span> All experiments
        </Link>
        <p className="eyebrow">Admin · metric registry</p>
        <h1 className="font-display text-3xl font-bold tracking-tight text-fg">
          Manage <span className="serif-accent">metrics</span>
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          The metric registry every experiment&apos;s results, winners and significance tests are
          computed against — see{" "}
          <code className="font-mono text-xs text-accent/90">lib/metrics.ts</code>. Add a metric
          here and it appears on every experiment&apos;s results page and the goal-metric picker
          with no deploy. Disabling a metric removes it from new verdict computations without
          losing its definition; deleting it is permanent.
        </p>
      </section>

      <MetricsAdmin initialMetrics={metrics} />
    </div>
  );
}
