"use client";

// Confirms ("type RESEED to enable") + POSTs to /api/admin/reseed and renders
// the result inline. Soft refresh on success so the home page picks up the
// new seeds without a full reload.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface ReseedResult {
  ok: boolean;
  before?: number;
  after?: number;
  ranAt?: string;
  experiments?: Array<{ key: string; name: string; active: boolean }>;
  error?: string;
}

const CONFIRM = "RESEED";

export function ReseedButton() {
  const router = useRouter();
  const [confirm, setConfirm] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ReseedResult | null>(null);

  const armed = confirm.trim() === CONFIRM;

  function onRun() {
    if (!armed || pending) return;
    startTransition(async () => {
      setResult(null);
      try {
        const res = await fetch("/api/admin/reseed", { method: "POST" });
        const data = (await res.json()) as ReseedResult;
        setResult(data);
        if (data.ok) {
          setConfirm("");
          // Refresh the home page's experiment list next time it's visited.
          router.refresh();
        }
      } catch (err) {
        setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  return (
    <section className="space-y-4 rounded-xl border border-line bg-surface p-5">
      <div className="space-y-2">
        <label htmlFor="reseed-confirm" className="block text-xs font-medium text-muted">
          Type{" "}
          <code className="font-mono text-xs text-accent/90">{CONFIRM}</code> to
          enable the button:
        </label>
        <input
          id="reseed-confirm"
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={CONFIRM}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="characters"
          className="w-full max-w-xs rounded-lg border border-line-strong bg-bg px-3 py-2 font-mono text-sm tracking-wider text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
      </div>

      <button
        type="button"
        onClick={onRun}
        disabled={!armed || pending}
        className={`rounded-lg px-5 py-2.5 font-display text-sm font-semibold transition duration-[120ms] ease-smooth ${
          armed && !pending
            ? "bg-bad text-bg hover:brightness-110 active:opacity-90"
            : "cursor-not-allowed bg-bg text-faint"
        }`}
      >
        {pending ? "Reseeding…" : "Reseed live DB"}
      </button>

      {result && <ResultPanel result={result} />}
    </section>
  );
}

function ResultPanel({ result }: { result: ReseedResult }) {
  if (!result.ok) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad"
      >
        Reseed failed: {result.error ?? "unknown error"}
      </div>
    );
  }
  return (
    <div
      role="status"
      className="space-y-3 rounded-lg border border-good/30 bg-good/10 px-4 py-3 text-sm text-good"
    >
      <p>
        <strong className="font-semibold">Reseed complete.</strong> Wiped {result.before ?? 0}{" "}
        experiments → inserted {result.after ?? 0}.{" "}
        {result.ranAt && (
          <span className="font-mono text-xs text-good/70">at {result.ranAt}</span>
        )}
      </p>
      {result.experiments && result.experiments.length > 0 && (
        <ul className="space-y-1 text-xs text-good/80">
          {result.experiments.map((e) => (
            <li key={e.key}>
              <code className="font-mono">{e.key}</code> — {e.active ? "active" : "paused"} —{" "}
              {e.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
