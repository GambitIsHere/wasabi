// ============================================================================
// Wasabi — cockpit homepage.
// ----------------------------------------------------------------------------
// A single server component that reads the whole live picture once (homeMetrics
// + the experiment registry + today's per-experiment assignment counts), decides
// each experiment's verdict server-side via the existing runResults + buildVerdict
// path, and hands flat view-models to the client table. Every payment/verdict-
// derived value degrades to a clean empty state when Metabase is unavailable
// (locally), so the page renders correctly with zero payment data.
//
// Sections top→bottom: header · KPI strip · alert banners · verdict table ·
// live-events + assignments panels.
import Link from "next/link";
import { homeMetrics, assignmentsTodayByExperiment } from "@/lib/home";
import { listExperiments, toRegistered } from "@/lib/store";
import { runResults } from "@/lib/metabase";
import { buildVerdict } from "@/lib/verdict";
import type { StoredExperiment } from "@/lib/mgmt";
import type { Recommendation } from "@/lib/verdict";
import { KpiStrip } from "@/components/home/KpiStrip";
import { AlertBanners, type NoTrafficFlag } from "@/components/home/AlertBanners";
import { ExperimentTable } from "@/components/home/ExperimentTable";
import { LiveEventsPanel } from "@/components/home/LiveEventsPanel";
import { AssignmentsPanel } from "@/components/home/AssignmentsPanel";
import type { ExperimentRowVM, GuardrailFlag } from "@/components/home/types";

// Re-read on every request: create/edit/toggle/assign all reflect immediately,
// and the live feed + payment KPIs are point-in-time.
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Server-side verdict summary — the payment/verdict half of a table row. Built
// only for ACTIVE experiments (paused ones read "queued"); NEVER throws — a
// Metabase-less environment simply yields { available: false }.
// ---------------------------------------------------------------------------

interface VerdictSummary {
  available: boolean;
  recommendation: Recommendation | null;
  subline: string | null;
  moneyValue: number | null;
  moneyControl: number | null;
  moneyDeltaAbs: number | null;
  moneyDeltaRel: number | null;
  guardrails: GuardrailFlag[];
}

const UNAVAILABLE: VerdictSummary = {
  available: false,
  recommendation: null,
  subline: null,
  moneyValue: null,
  moneyControl: null,
  moneyDeltaAbs: null,
  moneyDeltaRel: null,
  guardrails: [],
};

function gbp(n: number): string {
  return `£${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function daysSince(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

async function loadVerdict(exp: StoredExperiment): Promise<VerdictSummary> {
  const outcome = await runResults(toRegistered(exp));
  if (!outcome.available) return UNAVAILABLE;

  let built;
  try {
    built = buildVerdict(outcome.rows);
  } catch {
    return UNAVAILABLE;
  }

  const rows = outcome.rows;
  const control = rows.find((r) => r.isControl);
  if (!control) return UNAVAILABLE;
  const challenger = rows.find((r) => !r.isControl) ?? control;

  const moneyValue = challenger.revPerAcquired;
  const moneyControl = control.revPerAcquired;
  const moneyDeltaAbs = moneyValue - moneyControl;
  const moneyDeltaRel = moneyControl > 0 ? moneyDeltaAbs / moneyControl : 0;

  // Subline: name the £ leader; if a challenger leads, carry its strongest
  // driver's confidence label.
  const revWinner = built.winners.find((w) => w.metric === "rev_per_acquired");
  const controlLeads = !revWinner || revWinner.winner === built.controlVariant;
  let subline: string;
  if (controlLeads) {
    subline = `control · ${gbp(moneyControl)}/acq`;
  } else {
    const driver = built.significance
      .filter((s) => s.metric.endsWith(`· ${challenger.variant}`))
      .sort((a, b) => a.p - b.p)[0];
    subline = driver ? driver.label : "leads on £";
  }

  // Guardrail: a statistically significant NEGATIVE auth move on a variant.
  const guardrails: GuardrailFlag[] = built.significance
    .filter(
      (s) =>
        s.metric.startsWith("auth_rate") && s.significant && s.deltaPp < 0,
    )
    .map((s) => {
      const arm = s.metric.split("· ")[1] ?? challenger.variant;
      return {
        experimentKey: exp.key,
        arm,
        detail: `auth ${(s.variantRate * 100).toFixed(1)}% vs control ${(s.controlRate * 100).toFixed(1)}% (${s.deltaPp.toFixed(1)}pp, ${s.label})`,
      };
    });

  return {
    available: true,
    recommendation: built.recommendation,
    subline,
    moneyValue,
    moneyControl,
    moneyDeltaAbs,
    moneyDeltaRel,
    guardrails,
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function HomePage() {
  const [metrics, experiments, todayByKey] = await Promise.all([
    homeMetrics(),
    listExperiments(),
    assignmentsTodayByExperiment(),
  ]);

  // Verdicts, fanned out over ACTIVE experiments only (bounds the prod query
  // count; paused rows never need Metabase). Each degrades on its own.
  const verdictByKey = new Map<string, VerdictSummary>();
  await Promise.all(
    experiments
      .filter((e) => e.active)
      .map(async (e) => verdictByKey.set(e.key, await loadVerdict(e))),
  );

  // Build the flat row view-models + collect banner conditions in one pass.
  const guardrails: GuardrailFlag[] = [];
  const noTraffic: NoTrafficFlag[] = [];
  const rows: ExperimentRowVM[] = experiments.map((exp) => {
    const summary = verdictByKey.get(exp.key) ?? UNAVAILABLE;
    const todayCount = todayByKey[exp.key] ?? 0;
    const daysRunning = daysSince(exp.startDate);

    if (summary.available) guardrails.push(...summary.guardrails);
    if (exp.active && todayCount === 0 && daysRunning >= 1) {
      noTraffic.push({ experimentKey: exp.key, days: daysRunning });
    }

    return {
      key: exp.key,
      name: exp.name,
      business: exp.business,
      active: exp.active,
      startDate: exp.startDate,
      daysRunning,
      todayCount,
      split: exp.variants.map((v) => ({
        key: v.key,
        pct: v.rolloutPercentage,
        isControl: v.isControl,
      })),
      controlKey: exp.controlVariant,
      verdictAvailable: summary.available,
      recommendation: summary.recommendation,
      verdictSubline: summary.subline,
      moneyValue: summary.moneyValue,
      moneyControl: summary.moneyControl,
      moneyDeltaAbs: summary.moneyDeltaAbs,
      moneyDeltaRel: summary.moneyDeltaRel,
    };
  });

  const businessOptions = [...new Set(experiments.map((e) => e.business))].sort();
  const totalTests = experiments.length;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-bold tracking-tight text-fg">
              Experiments
            </h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-good/30 bg-good/10 px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-good">
              <span className="size-1.5 rounded-full bg-good" aria-hidden="true" />
              Live
            </span>
          </div>
          <p className="mt-1.5 font-mono text-xs text-faint">
            {totalTests} {totalTests === 1 ? "test" : "tests"} across{" "}
            {businessOptions.length}{" "}
            {businessOptions.length === 1 ? "business" : "businesses"} ·{" "}
            {metrics.activeTests} active · updated just now
          </p>
        </div>
        <Link href="/experiments/new" className="btn-primary">
          + New test
        </Link>
      </div>

      <KpiStrip metrics={metrics} />

      <AlertBanners guardrails={guardrails} noTraffic={noTraffic} />

      <ExperimentTable rows={rows} businesses={businessOptions} />

      <div className="grid gap-4 lg:grid-cols-2">
        <LiveEventsPanel feed={metrics.feed} />
        <AssignmentsPanel byBusiness={metrics.byBusiness} />
      </div>
    </div>
  );
}
