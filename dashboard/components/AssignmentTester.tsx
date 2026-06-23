"use client";

// Assignment tester — proves sticky assignment & the theme contract live.
// Enter a distinctId, POST /api/decide, and show which variant + theme slug
// that user gets for THIS experiment. Same id always yields the same arm.
import { useState } from "react";

interface DecideResponse {
  featureFlags: Record<string, boolean | string>;
  themes: Record<string, string>;
}

interface Props {
  experimentKey: string;
  /** A sensible default id so the field is never empty on first paint. */
  sampleId: string;
}

type ViewState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "done";
      distinctId: string;
      value: boolean | string;
      theme: string | null;
    }
  | { status: "error"; message: string };

export function AssignmentTester({ experimentKey, sampleId }: Props) {
  const [distinctId, setDistinctId] = useState(sampleId);
  const [view, setView] = useState<ViewState>({ status: "idle" });

  async function decide(id: string) {
    const trimmed = id.trim();
    if (!trimmed) {
      setView({ status: "error", message: "Enter a distinctId." });
      return;
    }
    setView({ status: "loading" });
    try {
      const res = await fetch("/api/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ distinctId: trimmed }),
      });
      if (!res.ok) {
        throw new Error(`/api/decide returned ${res.status}`);
      }
      const data = (await res.json()) as DecideResponse;
      const value = data.featureFlags[experimentKey];
      const theme = data.themes[experimentKey] ?? null;
      setView({
        status: "done",
        distinctId: trimmed,
        value: value ?? false,
        theme,
      });
    } catch (err) {
      setView({
        status: "error",
        message: err instanceof Error ? err.message : "Request failed",
      });
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void decide(distinctId);
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <h3 className="font-display text-sm font-semibold text-fg">
        Assignment tester
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Resolve a user against the live engine. The same{" "}
        <code className="font-mono text-faint">distinctId</code> always lands in
        the same variant — proof of sticky, storage-free assignment.
      </p>

      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={distinctId}
          onChange={(e) => setDistinctId(e.target.value)}
          placeholder="distinctId, e.g. user_42"
          spellCheck={false}
          autoComplete="off"
          className="flex-1 rounded-lg border border-line-strong bg-bg px-3 py-2 font-mono text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
        <button
          type="submit"
          disabled={view.status === "loading"}
          className="rounded-lg bg-accent px-4 py-2 font-display text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {view.status === "loading" ? "Resolving…" : "Resolve"}
        </button>
      </form>

      {/* Result region — fixed reserve avoids layout shift on first result. */}
      <div className="mt-4 min-h-[64px]" aria-live="polite">
        {view.status === "idle" && (
          <p className="text-xs text-faint">
            Submit an id to see its assignment.
          </p>
        )}

        {view.status === "loading" && (
          <div className="flex gap-2">
            <div className="skeleton h-14 flex-1" />
            <div className="skeleton h-14 flex-1" />
          </div>
        )}

        {view.status === "error" && (
          <p className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">
            {view.message}
          </p>
        )}

        {view.status === "done" && (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-line bg-bg px-3 py-2.5">
              <div className="font-mono text-[10px] font-medium uppercase tracking-wider text-faint">
                Variant
              </div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-fg">
                {view.value === false ? (
                  <span className="text-faint">not in test</span>
                ) : view.value === true ? (
                  "enabled"
                ) : (
                  <span className="text-accent">{view.value}</span>
                )}
              </div>
            </div>
            <div className="rounded-lg border border-line bg-bg px-3 py-2.5">
              <div className="font-mono text-[10px] font-medium uppercase tracking-wider text-faint">
                Routes to theme
              </div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-fg">
                {view.theme ? (
                  <span className="text-accent">?theme={view.theme}</span>
                ) : (
                  <span className="text-faint">default</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
