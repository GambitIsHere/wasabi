"use client";

// ============================================================================
// Root error boundary — Next.js App Router error.tsx.
// ----------------------------------------------------------------------------
// Catches any error thrown while rendering a route (or its data fetches) that
// isn't caught by a more specific segment boundary (e.g. app/backlog/error.tsx).
// Renders inside the root layout — nav/footer stay up — so the way back is
// always one click away. "Try again" re-renders the segment; the digest (if
// present) is a stable id for cross-referencing server logs.
// ============================================================================
import { useEffect } from "react";
import Link from "next/link";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[error boundary]", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-surface px-6 py-16 text-center">
      <div className="mb-3 text-3xl" aria-hidden="true">
        ⚠️
      </div>
      <h1 className="font-display text-lg font-semibold text-fg">
        Something went wrong
      </h1>
      <p className="mt-1.5 max-w-sm text-sm text-muted">
        This page hit an unexpected error. Try again, or head back and pick a
        different route.
      </p>
      {error.digest && (
        <p className="mt-2 font-mono text-[11px] text-faint">
          Ref: {error.digest}
        </p>
      )}
      <div className="mt-5 flex items-center gap-3">
        <button onClick={reset} className="btn-primary">
          Try again
        </button>
        <Link
          href="/"
          className="rounded-lg border border-line-strong bg-bg px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-fg"
        >
          Back home
        </Link>
      </div>
    </div>
  );
}
