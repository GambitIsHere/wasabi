"use client";

// ============================================================================
// PendingInvitesTable — the "Pending invites" section on /admin/members.
// ----------------------------------------------------------------------------
// Per row: Resend and Revoke. The raw invite token is never persisted
// (lib/invitations.ts stores only its hash — see that file's header), so an
// EXISTING link can't be reconstructed here. Resend sidesteps that by
// RE-ISSUING the invite — createInvitation refreshes the same row with a new
// token + a fresh 7-day expiry, invalidating the old link — and the returned
// link is the one moment it can be shown, so it's surfaced inline + copyable,
// exactly like InviteMemberForm's result panel. The token prefix is shown per
// row purely as an audit aid (mirrors api_key's key_prefix elsewhere), never
// turned back into a usable link.
// ============================================================================
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { inviteMember, revokeInvite } from "@/app/admin/members/actions";
import type { InvitationRole } from "@/lib/invitations";

export interface PendingInviteRow {
  id: string;
  email: string;
  role: InvitationRole;
  /** The inviter's email, resolved server-side from Invitation.invitedBy
   *  (a user id) — null for a not-found/system-issued invite. */
  invitedByEmail: string | null;
  expiresAt: string;
  tokenPrefix: string;
}

/** Coarse (day/hour) relative formatting only, on purpose — a second-level
 *  live countdown would drift between this component's server-rendered HTML
 *  and its client hydration and risk a hydration warning; day/hour buckets
 *  are stable across that gap in practice. */
function formatExpiry(expiresAtIso: string): string {
  const diffMs = new Date(expiresAtIso).getTime() - Date.now();
  if (diffMs <= 0) return "expired";
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days >= 1) return `in ${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.floor(diffMs / (60 * 60 * 1000)));
  return `in ${hours} hour${hours === 1 ? "" : "s"}`;
}

export function PendingInvitesTable({ invites }: { invites: PendingInviteRow[] }) {
  if (invites.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong bg-surface px-6 py-10 text-center text-sm text-muted">
        No pending invites.
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-line bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="text-left font-mono text-[11px] uppercase tracking-wider text-muted">
              <th scope="col" className="px-5 py-2.5 font-medium">
                Email
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                Role
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                Invited by
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                Expires
              </th>
              <th scope="col" className="px-5 py-2.5 text-right font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {invites.map((inv) => (
              <PendingInviteRowItem key={inv.id} invite={inv} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-5 py-3 text-[11px] text-faint">
        Resend re-issues a fresh link for that email with a new 7-day expiry — the old link stops
        working. A link is shown only when you create or resend an invite; it can&apos;t be recovered
        afterwards.
      </p>
    </section>
  );
}

function PendingInviteRowItem({ invite }: { invite: PendingInviteRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resentUrl, setResentUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const linkId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const revokeBtnRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (wasConfirming.current) revokeBtnRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  function onRevoke() {
    setError(null);
    startTransition(async () => {
      const res = await revokeInvite(invite.id);
      if (!res.ok) {
        setError(res.error);
        setConfirming(false);
        return;
      }
      router.refresh();
    });
  }

  // Resend = re-issue this invite for the same email + role. createInvitation
  // refreshes the existing row (new token + a fresh 7-day expiry) instead of
  // duplicating it, so the old link is invalidated and the returned link is the
  // one moment a working link can be shown — surfaced inline + copyable, so an
  // admin can re-send it without re-typing the email into the invite form.
  function onResend() {
    setError(null);
    setCopied(false);
    startTransition(async () => {
      const res = await inviteMember(invite.email, invite.role);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setResentUrl(res.inviteUrl);
      router.refresh(); // refresh the expiry column
    });
  }

  async function copyResent() {
    if (!resentUrl) return;
    try {
      await navigator.clipboard.writeText(resentUrl);
      setCopied(true);
    } catch {
      setCopied(false);
      setError("Couldn't copy automatically — select the link text and copy it manually.");
    }
  }

  return (
    <tr className="text-fg transition-colors hover:bg-surface-hover">
      <td className="px-5 py-3">
        <div className="font-mono text-xs text-fg">{invite.email}</div>
        <div className="mt-0.5 font-mono text-[10px] text-faint">token {invite.tokenPrefix}…</div>
      </td>
      <td className="px-3 py-3 font-mono text-xs text-muted">{invite.role}</td>
      <td className="px-3 py-3 text-muted">{invite.invitedByEmail ?? <span className="text-faint">—</span>}</td>
      <td className="px-3 py-3 text-muted">{formatExpiry(invite.expiresAt)}</td>
      <td className="px-5 py-3">
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-1.5">
            {!confirming && (
              <button
                type="button"
                onClick={onResend}
                disabled={pending}
                className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-faint transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? "…" : "Resend"}
              </button>
            )}
            {!confirming ? (
              <button
                type="button"
                ref={revokeBtnRef}
                onClick={() => setConfirming(true)}
                disabled={pending}
                className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-faint transition-colors hover:border-bad/40 hover:text-bad disabled:cursor-not-allowed disabled:opacity-50"
              >
                Revoke
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
                  onClick={onRevoke}
                  disabled={pending}
                  className="rounded-md border border-bad/50 bg-bad/15 px-2.5 py-1 text-xs font-medium text-bad hover:bg-bad/25"
                >
                  {pending ? "Revoking…" : "Confirm"}
                </button>
                <button
                  type="button"
                  ref={cancelRef}
                  onClick={() => setConfirming(false)}
                  disabled={pending}
                  className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-muted hover:text-fg"
                >
                  Cancel
                </button>
              </span>
            )}
          </div>

          {resentUrl && (
            <div role="status" className="flex w-full max-w-[22rem] items-center gap-1.5">
              <label htmlFor={linkId} className="sr-only">
                Fresh invite link for {invite.email}
              </label>
              <input
                id={linkId}
                type="text"
                readOnly
                value={resentUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full rounded-md border border-accent/30 bg-accent/5 px-2 py-1 font-mono text-[10px] text-fg focus:outline-none"
              />
              <button
                type="button"
                onClick={copyResent}
                className="shrink-0 rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] font-medium text-fg transition-colors hover:border-accent/60 hover:text-accent focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}

          {error && (
            <p role="alert" className="max-w-[16rem] text-right text-[11px] text-bad">
              {error}
            </p>
          )}
        </div>
      </td>
    </tr>
  );
}
