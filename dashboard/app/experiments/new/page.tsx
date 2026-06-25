import Link from "next/link";
import { ExperimentForm } from "@/components/ExperimentForm";
import {
  BUSINESSES,
  GOAL_METRICS,
  THEME_SLUGS,
  THEME_SLUG_RE,
  type ExperimentInput,
} from "@/lib/mgmt";

export const dynamic = "force-dynamic";

const VALID_BUSINESS = new Set<string>([...BUSINESSES]);

/**
 * Build the form's initial values, optionally prefilled from a backlog ticket's
 * query params (business / name / theme — set by the backlog "+ Test" link).
 * Invalid or stale params fall back to safe defaults, so a hand-edited URL can
 * never produce an invalid starting form.
 */
function buildInitial(p: {
  business: string;
  name: string;
  theme: string;
}): ExperimentInput {
  const business = VALID_BUSINESS.has(p.business) ? p.business : BUSINESSES[0];
  const theme = THEME_SLUG_RE.test(p.theme) ? p.theme : THEME_SLUGS[0];
  return {
    name: p.name.trim().slice(0, 120),
    business,
    goalMetric: GOAL_METRICS[0],
    startDate: new Date().toISOString().slice(0, 10),
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
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v) ?? "";
  const initial = buildInitial({
    business: str(sp.business),
    name: str(sp.name),
    theme: str(sp.theme),
  });
  const ticket = str(sp.ticket).trim();
  const ytHost = process.env.YOUTRACK_HOST || "sanjow.youtrack.cloud";

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
          slugged from the name and becomes the flag the engine assigns on.
        </p>
        {ticket && (
          <a
            href={`https://${ytHost}/issue/${ticket}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-info/30 bg-info/10 px-2.5 py-0.5 font-mono text-[11px] text-info transition-colors hover:border-info/50"
            title="The YouTrack ticket this experiment was prefilled from"
          >
            prefilled from {ticket} <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>

      <ExperimentForm mode="create" initial={initial} />
    </div>
  );
}
