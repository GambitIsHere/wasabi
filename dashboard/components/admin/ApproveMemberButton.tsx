"use client";

// ============================================================================
// ApproveMemberButton — one row's approve action on /admin/members.
// ----------------------------------------------------------------------------
// Client component only because it needs useTransition for a pending state
// and inline error display (mirrors components/ReseedButton.tsx's shape) —
// the actual authorization happens server-side in the action, twice over
// (see app/admin/members/actions.ts's header comment); this button being
// visible at all is not itself a security boundary.
// ============================================================================
import { useState, useTransition } from "react";
import { approvePendingUser } from "@/app/admin/members/actions";

export function ApproveMemberButton({ userId }: { userId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);

  function onApprove() {
    setError(null);
    startTransition(async () => {
      const result = await approvePendingUser(userId);
      if (result.ok) {
        setApproved(true);
      } else {
        setError(result.error);
      }
    });
  }

  if (approved) {
    return <span className="text-xs font-medium text-good">Approved</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onApprove}
        disabled={pending}
        className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-accent/60 hover:text-accent focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Approving…" : "Approve"}
      </button>
      {error && (
        <p role="alert" className="text-[11px] text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
