"use client";

// ============================================================================
// MemberRow — one row of the Settings member directory (app/settings).
// ----------------------------------------------------------------------------
// Client component for the interactive bits only: a role <select>, an Approve
// button for a pending account, and a two-click Remove. Every one of these
// calls a server action (app/settings/actions.ts) that RE-authorizes and
// re-applies the privilege model server-side — `canManage` / `assignableRoles`
// here only decide what to RENDER, never whether the mutation is allowed. The
// page recomputes both from the DB on the refresh a successful action triggers.
// ============================================================================
import { useState, useTransition } from "react";
import {
  approveMemberAction,
  changeMemberRoleAction,
  removeMemberAction,
} from "@/app/settings/actions";
import type { MembershipRole, UserStatus } from "@/lib/roles";

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const STATUS_STYLE: Record<UserStatus, string> = {
  active: "border-good/30 bg-good/10 text-good",
  pending: "border-warn/30 bg-warn/10 text-warn",
  suspended: "border-bad/30 bg-bad/10 text-bad",
};

export interface MemberRowProps {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  role: MembershipRole;
  status: UserStatus;
  isSelf: boolean;
  /** Whether the viewer may change this member's role / remove them. */
  canManage: boolean;
  /** Roles the viewer may set for this member — always includes the current one. */
  assignableRoles: MembershipRole[];
}

export function MemberRow({
  userId,
  email,
  name,
  image,
  role,
  status,
  isSelf,
  canManage,
  assignableRoles,
}: MemberRowProps) {
  const [pending, startTransition] = useTransition();
  const [currentRole, setCurrentRole] = useState<MembershipRole>(role);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onRoleChange(next: MembershipRole) {
    if (next === currentRole) return;
    const previous = currentRole;
    setError(null);
    setCurrentRole(next); // optimistic — reverted on failure
    startTransition(async () => {
      const result = await changeMemberRoleAction(userId, next);
      if (!result.ok) {
        setCurrentRole(previous);
        setError(result.error);
      }
    });
  }

  function onApprove() {
    setError(null);
    startTransition(async () => {
      const result = await approveMemberAction(userId);
      if (!result.ok) setError(result.error);
    });
  }

  function onRemove() {
    setError(null);
    startTransition(async () => {
      const result = await removeMemberAction(userId);
      if (!result.ok) {
        setError(result.error);
        setConfirmingRemove(false);
      }
    });
  }

  const initial = (name?.trim()?.[0] ?? email[0] ?? "?").toUpperCase();

  return (
    <tr className="border-t border-line align-top">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-bg font-mono text-xs text-muted">
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image} alt="" className="h-full w-full object-cover" />
            ) : (
              initial
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg">
              {name || email}
              {isSelf && (
                <span className="ml-2 rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-faint">
                  You
                </span>
              )}
            </p>
            {name && <p className="truncate font-mono text-[11px] text-faint">{email}</p>}
          </div>
        </div>
      </td>

      <td className="px-4 py-3">
        {canManage ? (
          <select
            aria-label={`Role for ${email}`}
            value={currentRole}
            disabled={pending}
            onChange={(e) => onRoleChange(e.target.value as MembershipRole)}
            className="rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-xs font-medium text-fg transition-colors hover:border-accent/60 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {assignableRoles.map((r) => (
              <option key={r} value={r}>
                {titleCase(r)}
              </option>
            ))}
          </select>
        ) : (
          <span className="font-mono text-xs text-muted">{titleCase(currentRole)}</span>
        )}
      </td>

      <td className="px-4 py-3">
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide ${STATUS_STYLE[status]}`}
        >
          {status}
        </span>
      </td>

      <td className="px-4 py-3">
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            {status === "pending" && (
              <button
                type="button"
                onClick={onApprove}
                disabled={pending}
                className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-accent/60 hover:text-accent focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? "Working…" : "Approve"}
              </button>
            )}
            {canManage &&
              (confirmingRemove ? (
                <>
                  <button
                    type="button"
                    onClick={onRemove}
                    disabled={pending}
                    className="rounded-lg border border-bad/50 bg-bad/10 px-3 py-1.5 text-xs font-medium text-bad transition-colors hover:border-bad focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bad/40 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {pending ? "Removing…" : "Confirm"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingRemove(false)}
                    disabled={pending}
                    className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingRemove(true)}
                  disabled={pending}
                  className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-bad/60 hover:text-bad focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bad/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Remove
                </button>
              ))}
            {!canManage && status !== "pending" && (
              <span className="font-mono text-[11px] text-faint">—</span>
            )}
          </div>
          {error && (
            <p role="alert" className="text-[11px] text-bad">
              {error}
            </p>
          )}
        </div>
      </td>
    </tr>
  );
}
