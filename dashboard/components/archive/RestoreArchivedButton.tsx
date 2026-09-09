"use client";

// Restore an archived run back to a live, PAUSED experiment. Calls the
// restoreExperiment server action; on success the run is live again (paused for
// review), so we land the user on its edit page. Meaningful mainly for native
// completions, but harmless for VWO imports (they restore with the variant key
// as the theme slug), so it's shown for every archived run.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { restoreExperiment } from "@/app/actions";

export function RestoreArchivedButton({ archivedKey }: { archivedKey: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function restore() {
    setError(null);
    startTransition(async () => {
      const res = await restoreExperiment(archivedKey);
      if (!res.ok) setError(res.error);
      else router.push(`/experiments/${res.key}/edit`);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={restore}
        disabled={pending}
        className="shrink-0 rounded-lg border border-accent/40 bg-accent/10 px-3.5 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Restoring…" : "Restore to live"}
      </button>
      {error && (
        <p className="max-w-[18rem] text-right text-[11px] text-bad">{error}</p>
      )}
    </div>
  );
}
