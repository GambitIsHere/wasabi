"use client";

// ============================================================================
// AcceptInviteForm — the create-account-on-accept form (Task C, client).
// ----------------------------------------------------------------------------
// Shown on /accept-invite ONLY when the invited email has no account yet — the
// off-domain consultant/QA the invite system exists for. Calls the
// acceptInviteAsNewUser server action (app/accept-invite/actions.ts), which
// does every security decision server-side (token validity, the no-duplicate
// guard, password strength, the deliberate domain bypass).
//
// 🔴 The email is READ-ONLY and comes from props (the invite record), never an
// editable field: identity is the invite's, not the form's — a user must never
// be able to point this at a different address. Mirrors RegisterForm's
// client-side pre-checks / useTransition shape for consistency with the rest
// of the app's forms; the server action re-checks all of it regardless.
// ============================================================================
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
// MUST be "@/lib/password-policy", never "@/lib/password" — this is a client
// component, and lib/password.ts guards itself with `if (typeof window) throw`
// AND imports a native Node addon. See lib/password-policy.ts's header.
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";
import type { InvitationRole } from "@/lib/invitations";
import { acceptInviteAsNewUser } from "./actions";

interface Props {
  token: string;
  role: InvitationRole;
  /** The invited address — shown read-only, submitted by the server action
   *  from the invite record (not this value). */
  email: string;
}

const INPUT_CLS =
  "rounded-lg border border-line-strong bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40";

export function AcceptInviteForm({ token, role, email }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const signInHref = `/signin?email=${encodeURIComponent(email)}`;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    // Cheap client-side pre-checks for instant feedback — the server action is
    // the real gate and re-checks both (plus strength) regardless.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    startTransition(async () => {
      const res = await acceptInviteAsNewUser(token, { name, password, confirmPassword });
      if (!res.ok) {
        setError(res.reason);
        return;
      }
      // Account created + membership granted. No session yet (this is a
      // brand-new account) — send them to sign in with the invited address.
      setDone(true);
      router.push(signInHref);
    });
  }

  if (done) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="space-y-2 rounded-lg border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-fg"
      >
        <p className="font-medium">Account created.</p>
        <p className="text-muted">
          Taking you to sign in as <span className="text-fg">{email}</span>…{" "}
          <a href={signInHref} className="font-medium text-accent hover:underline">
            Go to sign in
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Email</span>
        <input
          type="email"
          name="email"
          value={email}
          readOnly
          aria-readonly="true"
          tabIndex={-1}
          autoComplete="username"
          className={`${INPUT_CLS} cursor-not-allowed font-mono text-xs text-muted`}
        />
        <span className="text-[11px] text-faint">
          You&apos;ll sign in with this address. It can&apos;t be changed — it&apos;s who the invite
          is for.
        </span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">
          Name <span className="text-faint">(optional)</span>
        </span>
        <input
          type="text"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          placeholder="How your name shows to the team"
          className={INPUT_CLS}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Password</span>
        <input
          type="password"
          name="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby="accept-password-help"
          className={INPUT_CLS}
        />
        <span id="accept-password-help" className="text-[11px] text-faint">
          At least {MIN_PASSWORD_LENGTH} characters. No simple sequences, repeated characters, or
          common passwords.
        </span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Confirm password</span>
        <input
          type="password"
          name="confirmPassword"
          required
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className={INPUT_CLS}
        />
      </label>

      <div aria-live="assertive" className="empty:hidden">
        {error && (
          <p role="alert" className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
            {error}
          </p>
        )}
      </div>

      <button type="submit" disabled={pending} className="btn-primary w-full py-3">
        {pending ? "Creating account…" : `Join as ${role}`}
      </button>
    </form>
  );
}
