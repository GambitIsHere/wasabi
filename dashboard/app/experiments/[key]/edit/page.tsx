import Link from "next/link";
import { notFound } from "next/navigation";
import { getExperiment } from "@/lib/store";
import { ExperimentForm } from "@/components/ExperimentForm";
import type { ExperimentInput } from "@/lib/mgmt";

export const dynamic = "force-dynamic";

export default async function EditExperimentPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const exp = await getExperiment(key);
  if (!exp) notFound();

  // StoredExperiment → ExperimentInput (the form's shape). Key is carried so the
  // form can show it immutable and the action can lock identity.
  const initial: ExperimentInput = {
    name: exp.name,
    key: exp.key,
    business: exp.business,
    goalMetric: exp.goalMetric,
    startDate: exp.startDate,
    description: exp.description,
    variants: exp.variants,
  };

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href={`/experiments/${exp.key}`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-faint transition-colors hover:text-fg"
        >
          <span aria-hidden="true">←</span> Back to experiment
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-bold tracking-tight text-fg">
            Edit {exp.name}
          </h1>
          <code className="font-mono text-xs text-faint">{exp.key}</code>
        </div>
      </div>

      <ExperimentForm mode="edit" initial={initial} />
    </div>
  );
}
