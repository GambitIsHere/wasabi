"use client";

// Complete a live experiment into the archive: pick the winning variant, a
// verdict (winner / inconclusive / lost) and an optional note, then call the
// completeExperiment server action. On success the run has moved to the archive,
// so we land the user on its archived detail page. A popover opened from the
// detail header, next to the existing Edit / Pause / Delete controls.
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { completeExperiment } from "@/app/actions";
import type { ArchivedStatus } from "@/lib/archive";

/** The verdicts a completion can carry — the neutral "archived" catch-all is
 *  never a deliberate pick here, so it's not offered. */
const VERDICTS: { value: Extract<ArchivedStatus, "winner" | "inconclusive" | "lost">; label: string }[] = [
  { value: "winner", label: "Winner" },
  { value: "inconclusive", label: "Inconclusive" },
  { value: "lost", label: "Lost" },
];

interface Props {
  experimentKey: string;
  /** The experiment's variant keys — the winner select's options. */
  variantKeys: string[];
  /** The control variant key — the default winner selection. */
  controlVariant: string;
}

export function CompleteExperimentForm({ experimentKey, variantKeys, controlVariant }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [winner, setWinner] = useState(controlVariant || variantKeys[0] || "");
  const [status, setStatus] = useState<ArchivedStatus>("winner");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Move focus into the panel when it opens; return it to the trigger when it
  // closes — but never on the initial mount, where `open` starts false.
  useEffect(() => {
    if (open) selectRef.current?.focus();
    else if (wasOpen.current) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await completeExperiment(experimentKey, {
        winnerVariant: winner,
        status,
        notes: notes.trim() || undefined,
      });
      if (!res.ok) setError(res.error);
      else router.push(`/archive/${res.key}`);
    });
  }

  const inputClass =
    "rounded-lg border border-line-strong bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40";

  return (
    <div className="relative">
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="rounded-lg border border-accent/40 bg-accent/10 px-3.5 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Complete
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Complete experiment"
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          className="absolute right-0 top-full z-20 mt-2 w-80 space-y-4 rounded-xl border border-line-strong bg-surface p-4 text-left shadow-lg"
        >
          <div className="space-y-1">
            <p className="font-display text-sm font-semibold text-fg">Complete &amp; archive</p>
            <p className="text-[11px] leading-relaxed text-faint">
              Freezes the current results into the archive, then removes the live test.
            </p>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Winning variant</span>
            <select
              ref={selectRef}
              value={winner}
              onChange={(e) => setWinner(e.target.value)}
              disabled={pending}
              className={inputClass}
            >
              {variantKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                  {k === controlVariant ? " (control)" : ""}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-medium text-muted">Verdict</legend>
            <div className="flex flex-wrap gap-3">
              {VERDICTS.map((v) => (
                <label key={v.value} className="flex items-center gap-1.5 text-xs text-fg">
                  <input
                    type="radio"
                    name="verdict"
                    value={v.value}
                    checked={status === v.value}
                    onChange={() => setStatus(v.value)}
                    disabled={pending}
                    className="accent-[var(--color-accent)]"
                  />
                  {v.label}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">
              Note <span className="text-faint">(optional)</span>
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              disabled={pending}
              placeholder="What the test showed, and why this call."
              className={`resize-y ${inputClass} leading-relaxed`}
            />
          </label>

          {error && (
            <p className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={pending}
              className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-fg disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending || !winner}
              className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Archiving…" : "Archive test"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
