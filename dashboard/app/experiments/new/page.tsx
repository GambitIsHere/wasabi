import Link from "next/link";
import { ExperimentForm } from "@/components/ExperimentForm";
import {
  BUSINESSES,
  GOAL_METRICS,
  THEME_SLUGS,
  type ExperimentInput,
} from "@/lib/mgmt";

export const dynamic = "force-dynamic";

/** A blank-but-valid-shaped starter: two arms, control + challenger, 50/50. */
const BLANK: ExperimentInput = {
  name: "",
  business: BUSINESSES[0],
  goalMetric: GOAL_METRICS[0],
  startDate: new Date().toISOString().slice(0, 10),
  variants: [
    { key: "control", rolloutPercentage: 50, themeSlug: THEME_SLUGS[0], isControl: true },
    { key: "variant_1", rolloutPercentage: 50, themeSlug: THEME_SLUGS[0], isControl: false },
  ],
};

export default function NewExperimentPage() {
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
      </div>

      <ExperimentForm mode="create" initial={BLANK} />
    </div>
  );
}
