"use client";

// ============================================================================
// Backlog segment error boundary — Next.js App Router error.tsx.
// ----------------------------------------------------------------------------
// app/backlog/page.tsx pulls live from YouTrack on every request (see
// lib/backlog.ts). Both of that lib's query paths already degrade to an empty
// backlog on failure, so this boundary is the last-resort net for anything
// that still slips through (a genuine network/outage blip, an expired token,
// etc.) — copy below leads with that likely cause. "Try again" re-runs the
// backlog server component.
// ============================================================================
import { useEffect } from "react";

export default function BacklogError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[backlog] page error:", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-surface px-6 py-16 text-center">
      <div className="mb-3 text-3xl" aria-hidden="true">
        📡
      </div>
      <h1 className="font-display text-lg font-semibold text-fg">
        Couldn&apos;t load the backlog
      </h1>
      <p className="mt-1.5 max-w-sm text-sm text-muted">
        The live pull from YouTrack didn&apos;t come back — likely a network
        hiccup or an expired token. Try again in a moment.
      </p>
      {error.digest && (
        <p className="mt-2 font-mono text-[11px] text-faint">
          Ref: {error.digest}
        </p>
      )}
      <button
        onClick={reset}
        className="mt-5 rounded-lg bg-accent px-4 py-2 font-display text-sm font-semibold text-bg transition-opacity hover:opacity-90"
      >
        Try again
      </button>
    </div>
  );
}
