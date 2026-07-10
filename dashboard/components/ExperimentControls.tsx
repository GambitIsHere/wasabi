"use client";

// Activate/Pause toggle + Delete (with confirm) for one experiment. Used on the
// home cards (compact) and the detail header (full). Drives the server actions
// and reflects state via router.refresh() after the action resolves, so the
// list/detail re-read from the DB — no optimistic divergence.
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setExperimentActive, deleteExperiment } from "@/app/actions";

interface Props {
  experimentKey: string;
  active: boolean;
  /** "card" = compact inline controls; "header" = larger detail-page buttons. */
  variant?: "card" | "header";
  /** Where to go after a successful delete (default: stay/refresh). */
  redirectOnDelete?: string;
}

export function ExperimentControls({
  experimentKey,
  active,
  variant = "card",
  redirectOnDelete,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteBtnRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // Move focus to Cancel when the confirm step opens; return it to the Delete
  // trigger when it closes (Cancel / Escape / failed delete) — but never on the
  // initial mount, where `confirming` starts false.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (wasConfirming.current) deleteBtnRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  function toggle() {
    setError(null);
    startTransition(async () => {
      const res = await setExperimentActive(experimentKey, !active);
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      const res = await deleteExperiment(experimentKey);
      if (!res.ok) {
        setError(res.error);
        setConfirming(false);
        return;
      }
      if (redirectOnDelete) router.push(redirectOnDelete);
      else router.refresh();
    });
  }

  const big = variant === "header";
  const btnBase = big
    ? "rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
    : "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          disabled={pending}
          aria-pressed={active}
          className={`${btnBase} ${
            active
              ? "border border-warn/40 bg-warn/10 text-warn hover:bg-warn/20"
              : "border border-good/40 bg-good/10 text-good hover:bg-good/20"
          }`}
        >
          {pending ? "…" : active ? "Pause" : "Activate"}
        </button>

        {!confirming ? (
          <button
            type="button"
            ref={deleteBtnRef}
            onClick={() => setConfirming(true)}
            disabled={pending}
            className={`${btnBase} border border-line-strong bg-surface text-faint hover:border-bad/40 hover:text-bad`}
          >
            Delete
          </button>
        ) : (
          <span
            className="flex items-center gap-1.5"
            onKeyDown={(e) => {
              if (e.key === "Escape") setConfirming(false);
            }}
          >
            <button
              type="button"
              onClick={remove}
              disabled={pending}
              className={`${btnBase} border border-bad/50 bg-bad/15 text-bad hover:bg-bad/25`}
            >
              {pending ? "Deleting…" : "Confirm"}
            </button>
            <button
              type="button"
              ref={cancelRef}
              onClick={() => setConfirming(false)}
              disabled={pending}
              className={`${btnBase} border border-line-strong bg-surface text-muted hover:text-fg`}
            >
              Cancel
            </button>
          </span>
        )}
      </div>
      {error && (
        <p className="max-w-[18rem] text-right text-[11px] text-bad">{error}</p>
      )}
    </div>
  );
}
