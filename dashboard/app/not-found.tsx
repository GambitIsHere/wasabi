import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-surface px-6 py-16 text-center">
      <div className="mb-3 text-3xl" aria-hidden="true">
        🌶
      </div>
      <h1 className="font-display text-lg font-semibold text-fg">
        Page not found
      </h1>
      <p className="mt-1.5 max-w-sm text-sm text-muted">
        That page isn&apos;t part of Optimiser.Pro. Check the address, or head back to
        the experiments.
      </p>
      <Link href="/" className="btn-primary mt-5">
        Back to experiments
      </Link>
    </div>
  );
}
