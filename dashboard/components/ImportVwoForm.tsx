"use client";

// Paste a JSON array of VWO/Wingify campaigns (produced by the import agent) and
// POST it to /api/admin/import-vwo. Idempotent upsert — safe to re-run. Renders
// the per-campaign result inline and soft-refreshes so /archive picks it up.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface ImportResult {
  ok: boolean;
  before?: number;
  after?: number;
  ranAt?: string;
  imported?: string[];
  failed?: { name: string; error: string }[];
  error?: string;
}

const PLACEHOLDER = `[
  {
    "name": "TU — Billing UK: £19 vs £39",
    "business": "Top Up",
    "source": "vwo",
    "sourceId": "123456",
    "type": "A/B",
    "status": "winner",
    "goalMetric": "Purchase",
    "startDate": "2026-03-01",
    "endDate": "2026-04-05",
    "winnerVariant": "variation-1",
    "variants": [
      { "key": "control", "name": "Control", "isControl": true, "visitors": 8120, "conversions": 244 },
      { "key": "variation-1", "name": "£19 / 14-day", "visitors": 8090, "conversions": 405, "chanceToBeat": 99.2 }
    ]
  }
]`;

export function ImportVwoForm() {
  const router = useRouter();
  const [json, setJson] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ImportResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  function onImport() {
    if (pending || json.trim().length === 0) return;
    // Validate JSON client-side first so a paste typo is a friendly message,
    // not a 400.
    try {
      JSON.parse(json);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Invalid JSON.");
      return;
    }
    setParseError(null);
    startTransition(async () => {
      setResult(null);
      try {
        const res = await fetch("/api/admin/import-vwo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: json,
        });
        const data = (await res.json()) as ImportResult;
        setResult(data);
        if (data.ok) router.refresh();
      } catch (err) {
        setResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  return (
    <section className="space-y-4 rounded-xl border border-line bg-surface p-5">
      <div className="space-y-2">
        <label
          htmlFor="import-json"
          className="block text-xs font-medium text-muted"
        >
          Paste the campaigns JSON (array, or{" "}
          <code className="font-mono text-xs text-accent/90">
            {"{ experiments: [...] }"}
          </code>
          ):
        </label>
        <textarea
          id="import-json"
          value={json}
          onChange={(e) => setJson(e.target.value)}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          autoComplete="off"
          rows={14}
          className="w-full rounded-lg border border-line-strong bg-bg px-3 py-2 font-mono text-xs leading-relaxed text-fg placeholder:text-faint/60 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
        {parseError && (
          <p className="text-xs text-bad" role="alert">
            Invalid JSON — {parseError}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={onImport}
        disabled={pending || json.trim().length === 0}
        className={`rounded-lg px-5 py-2.5 font-display text-sm font-semibold transition-all duration-200 ease-expo ${
          !pending && json.trim().length > 0
            ? "bg-accent text-bg hover:-translate-y-0.5 hover:shadow-[0_8px_24px_-8px_rgba(0,229,160,0.45)]"
            : "cursor-not-allowed bg-bg text-faint"
        }`}
      >
        {pending ? "Importing…" : "Import experiments"}
      </button>

      {result && <ResultPanel result={result} />}
    </section>
  );
}

function ResultPanel({ result }: { result: ImportResult }) {
  if (!result.ok) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad"
      >
        Import failed: {result.error ?? "unknown error"}
      </div>
    );
  }
  const imported = result.imported ?? [];
  const failed = result.failed ?? [];
  return (
    <div
      role="status"
      className="space-y-3 rounded-lg border border-good/30 bg-good/10 px-4 py-3 text-sm text-good"
    >
      <p>
        <strong className="font-semibold">Import complete.</strong> {imported.length}{" "}
        upserted · archive now holds {result.after ?? 0} (was {result.before ?? 0}).{" "}
        {result.ranAt && (
          <span className="font-mono text-xs text-good/70">at {result.ranAt}</span>
        )}
      </p>
      {imported.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {imported.map((k) => (
            <li
              key={k}
              className="rounded bg-good/15 px-1.5 py-0.5 font-mono text-[10px] text-good/90"
            >
              {k}
            </li>
          ))}
        </ul>
      )}
      {failed.length > 0 && (
        <ul className="space-y-1 border-t border-good/20 pt-2 text-xs text-warn">
          {failed.map((f, i) => (
            <li key={i}>
              <span className="text-fg">{f.name}</span> — {f.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
