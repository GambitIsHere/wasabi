import Link from "next/link";
import { ExperimentForm, type GoalMetricOption } from "@/components/ExperimentForm";
import { SampleSizeCalculator } from "@/components/SampleSizeCalculator";
import {
  BUSINESSES,
  THEME_SLUGS,
  THEME_SLUG_RE,
  nextExpId,
  type ExperimentInput,
} from "@/lib/mgmt";
import { getMetrics } from "@/lib/metrics";
import { listExperiments } from "@/lib/store";
import { listArchived } from "@/lib/archive";

export const dynamic = "force-dynamic";

const VALID_BUSINESS = new Set<string>(BUSINESSES.map((b) => b.label));

/**
 * The next free EXP id — a single running counter across ALL experiments. Scans
 * every live + archived experiment's key AND name for `EXP<n>` and returns the
 * padded successor (see nextExpId). Both reads are tenant-scoped; a DB hiccup
 * degrades to EXP001 (still an editable default) rather than taking the page
 * down.
 */
async function suggestNextExpId(): Promise<string> {
  try {
    const [live, archived] = await Promise.all([listExperiments(), listArchived()]);
    return nextExpId([
      ...live.flatMap((e) => [e.key, e.name]),
      ...archived.flatMap((a) => [a.key, a.name]),
    ]);
  } catch {
    return nextExpId([]);
  }
}

/**
 * Build the form's initial values, optionally prefilled from a backlog ticket's
 * query params (business / name / theme — set by the backlog "+ Test" link).
 * Invalid or stale params fall back to safe defaults, so a hand-edited URL can
 * never produce an invalid starting form. `defaultGoalMetric` is the registry's
 * first isGoal metric (display-ordered) — "" (no registry goal metrics exist
 * yet) is a valid, honest starting point: the form simply won't validate until
 * one exists, rather than pretending a hardcoded metric is still real.
 */
function buildInitial(p: {
  business: string;
  name: string;
  theme: string;
  defaultGoalMetric: string;
}): ExperimentInput {
  const business = VALID_BUSINESS.has(p.business) ? p.business : BUSINESSES[0].label;
  const theme = THEME_SLUG_RE.test(p.theme) ? p.theme : THEME_SLUGS[0];
  return {
    name: p.name.trim().slice(0, 120),
    business,
    goalMetric: p.defaultGoalMetric,
    startDate: new Date().toISOString().slice(0, 10),
    description: "",
    variants: [
      { key: "control", rolloutPercentage: 50, themeSlug: theme, isControl: true },
      { key: "variant_1", rolloutPercentage: 50, themeSlug: theme, isControl: false },
    ],
  };
}

export default async function NewExperimentPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const [sp, metrics, suggestedId] = await Promise.all([
    searchParams,
    getMetrics(),
    suggestNextExpId(),
  ]);
  const goalMetricOptions: GoalMetricOption[] = metrics
    .filter((m) => m.isGoal)
    .map((m) => ({ key: m.key, label: m.label, description: m.description }));
  const str = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v) ?? "";
  const initial = buildInitial({
    business: str(sp.business),
    name: str(sp.name),
    theme: str(sp.theme),
    defaultGoalMetric: goalMetricOptions[0]?.key ?? "",
  });
  // The `?ticket=` deep-link seeds the YouTrack ticket field now (NOT the Unique
  // ID — that's the running EXP counter).
  const ticket = str(sp.ticket).trim();

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-faint transition-colors hover:text-fg"
        >
          <span aria-hidden="true">←</span> All experiments
        </Link>
        <h1 className="font-display text-3xl font-bold tracking-tight text-fg">
          New experiment
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted">
          Configure the arms and the storefront theme each routes to. The key is
          slugged from the Unique ID and becomes the flag the engine assigns on.
        </p>
      </div>

      {/* Planning aid — sizes the test from typed numbers. Rendered outside the
          form so it shares no state with experiment creation and can't touch
          assignment or capture; see components/SampleSizeCalculator.tsx. */}
      <SampleSizeCalculator />

      <ExperimentForm
        mode="create"
        initial={initial}
        goalMetricOptions={goalMetricOptions}
        initialUniqueId={suggestedId}
        initialTicket={ticket}
      />
    </div>
  );
}
