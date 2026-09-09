"use client";

// ============================================================================
// InviteMemberForm — the "Invite a member" section on /admin/members.
// ----------------------------------------------------------------------------
// Calls the inviteMember server action (app/admin/members/actions.ts), which
// creates the invite AND attempts to email it (lib/email.ts's
// sendInvitationEmail — returns false today, no provider configured). Because
// the raw invite token is never persisted (lib/invitations.ts's header: only
// its hash is stored), THIS result panel is the one and only moment the link
// can ever be shown — once it's cleared (a fresh invite, or navigating away),
// that exact link is gone for good; the admin has to copy it now or send a
// new invite later to get a fresh one. The panel makes the "email isn't
// configured — copy this instead" state explicit rather than leaving the
// admin to wonder why nothing arrived in the invitee's inbox.
// ============================================================================
import { useId, useState, useTransition } from "react";
import { inviteMember } from "@/app/admin/members/actions";

// Mirrors lib/invitations.ts's own (unexported) INVITATION_ROLES — "owner" is
// deliberately excluded from every invite path, enforced server-side by
// isInvitationRole() regardless of what this dropdown offers. An existing
// member can only ever become an owner via the members table below (an
// explicit promotion by another owner), never by invite.
const INVITE_ROLES = ["admin", "editor", "viewer"] as const;
type InviteRole = (typeof INVITE_ROLES)[number];

const INPUT_CLS =
  "w-full rounded-lg border border-line-strong bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40";
const LABEL_CLS = "text-xs font-medium text-muted";

interface InviteResult {
  email: string;
  inviteUrl: string;
  emailed: boolean;
}

export function InviteMemberForm() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("viewer");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [copied, setCopied] = useState(false);
  const formId = useId();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCopied(false);
    const trimmed = email.trim();
    startTransition(async () => {
      const res = await inviteMember(trimmed, role);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setResult({ email: trimmed, inviteUrl: res.inviteUrl, emailed: res.emailed });
      setEmail("");
    });
  }

  async function copyLink() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.inviteUrl);
      setCopied(true);
    } catch {
      setCopied(false);
      setError("Couldn't copy automatically — select the link text and copy it manually.");
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-line bg-surface p-5">
      <h2 className="font-display text-sm font-semibold text-fg">Invite a member</h2>

      <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1.5">
          <span className={LABEL_CLS}>Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="consultant@example.com"
            autoComplete="off"
            spellCheck={false}
            className={INPUT_CLS}
          />
        </label>
        <label className="flex flex-col gap-1.5 sm:w-40">
          <span className={LABEL_CLS}>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as InviteRole)} className={INPUT_CLS}>
            {INVITE_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending || email.trim().length === 0}
          className="btn-primary px-4 py-2 text-sm"
        >
          {pending ? "Sending…" : "Send invite"}
        </button>
      </form>

      <div aria-live="polite" className="space-y-2 empty:hidden">
        {error && (
          <p role="alert" className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
            {error}
          </p>
        )}
        {result && (
          <div role="status" className="space-y-2.5 rounded-lg border border-accent/30 bg-accent/10 px-4 py-3">
            <p className="text-sm text-fg">
              Invite created for <span className="font-mono text-xs">{result.email}</span>.{" "}
              {result.emailed
                ? "An email was sent."
                : "Email delivery isn't configured yet — send this link to the person directly."}
            </p>
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
              <label htmlFor={`${formId}-link`} className="sr-only">
                Invite link for {result.email}
              </label>
              <input
                id={`${formId}-link`}
                type="text"
                readOnly
                value={result.inviteUrl}
                onFocus={(e) => e.currentTarget.select()}
                className={`${INPUT_CLS} font-mono text-xs`}
              />
              <button
                type="button"
                onClick={copyLink}
                className="shrink-0 rounded-lg border border-line-strong bg-surface px-3 py-2 text-xs font-medium text-fg transition-colors hover:border-accent/60 hover:text-accent focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
            <p className="text-[11px] text-faint">
              This link expires in 7 days and works once. It won&apos;t be shown again after you leave
              this page — send another invite to the same email later to get a fresh one.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
