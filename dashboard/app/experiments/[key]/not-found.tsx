import Link from "next/link";

export default function ExperimentNotFound() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-surface px-6 py-16 text-center">
      <div className="mb-3 text-3xl" aria-hidden="true">
        🌶
      </div>
      <h1 className="font-display text-lg font-semibold text-fg">
        Experiment not found
      </h1>
      <p className="mt-1.5 max-w-sm text-sm text-muted">
        That experiment key isn&apos;t in the Wasabi registry.
      </p>
      <Link href="/" className="btn-primary mt-5">
        Back to experiments
      </Link>
    </div>
  );
}
