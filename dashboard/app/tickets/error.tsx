"use client";

// ============================================================================
// Tickets segment error boundary — Next.js App Router error.tsx.
// ----------------------------------------------------------------------------
// app/tickets/page.tsx already degrades a failed DB read to an empty read-only
// board, so this boundary is the last-resort net for anything that still slips
// through (an unexpected render error). "Try again" re-runs the tickets server
// component. Mirrors app/backlog/error.tsx.
// ============================================================================
import { useEffect } from "react";

export default function TicketsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[tickets] page error:", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-surface px-6 py-16 text-center">
      <div className="mb-3 text-3xl" aria-hidden="true">
        🗂️
      </div>
      <h1 className="font-display text-lg font-semibold text-fg">
        Couldn&apos;t load the tickets board
      </h1>
      <p className="mt-1.5 max-w-sm text-sm text-muted">
        Something went wrong reading this workspace&apos;s tickets — most likely a database
        hiccup. Try again in a moment.
      </p>
      {error.digest && (
        <p className="mt-2 font-mono text-[11px] text-faint">Ref: {error.digest}</p>
      )}
      <button onClick={reset} className="btn-primary mt-5">
        Try again
      </button>
    </div>
  );
}
