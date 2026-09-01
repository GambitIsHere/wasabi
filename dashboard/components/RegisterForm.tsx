"use client";

// ============================================================================
// RegisterForm — the /register email+password form (client).
// ----------------------------------------------------------------------------
// Posts to app/api/register/route.ts via fetch (not a server action — see
// that route's header comment on why: it needs to return a literal 429).
// Mirrors ExperimentForm's inline-error / useTransition shape for
// consistency with the rest of the admin UI's forms.
//
// On success, shows one of two messages depending on `emailSent` — the
// "no email provider configured" path the batch spec asks to make obvious:
// requirement 3 says a self-registered account needs EITHER a clicked
// verification link OR an org owner/admin approval before it can sign in;
// today emailSent is always false (lib/email-verification.ts has no real
// provider wired up), so the second message is what every registration sees
// — never a "you're all set" that isn't true yet.
// ============================================================================
import { useState, useTransition } from "react";
// MUST be "@/lib/password-policy", never "@/lib/password" — this is a client
// component, and lib/password.ts both guards itself with `if (typeof window
// !== "undefined") throw` AND imports a native Node addon (@node-rs/argon2);
// either would break the browser bundle. See lib/password-policy.ts's header.
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";

interface Props {
  /** Shown as placeholder/helper text only — the actual restriction is
   *  enforced server-side (see app/api/register/route.ts). */
  allowedDomain: string;
}

interface RegisterApiResponse {
  ok: boolean;
  error?: string;
  emailSent?: boolean;
}

export function RegisterForm({ allowedDomain }: Props) {
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ emailSent: boolean } | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    startTransition(async () => {
      try {
        const res = await fetch("/api/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password, confirmPassword }),
        });
        const data = (await res.json()) as RegisterApiResponse;
        if (!res.ok || !data.ok) {
          setError(data.error ?? "Something went wrong. Try again.");
          return;
        }
        setResult({ emailSent: data.emailSent ?? false });
      } catch {
        setError("Couldn't reach the server. Check your connection and try again.");
      }
    });
  }

  if (result) {
    return (
      <div role="status" aria-live="polite" className="space-y-2 rounded-lg border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-fg">
        <p className="font-medium">Account created — pending approval.</p>
        {result.emailSent ? (
          <p className="text-muted">
            Check <span className="text-fg">{email}</span> for a verification link to finish
            activating your account.
          </p>
        ) : (
          <p className="text-muted">
            No email verification is configured for this workspace yet, so an existing owner or
            admin will need to approve your account before you can sign in.
          </p>
        )}
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
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={`you@${allowedDomain}`}
          className="rounded-lg border border-line-strong bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
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
          aria-describedby="password-help"
          className="rounded-lg border border-line-strong bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
        <span id="password-help" className="text-[11px] text-faint">
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
          className="rounded-lg border border-line-strong bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
      </label>

      {error && (
        <p role="alert" className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
          {error}
        </p>
      )}

      <button type="submit" disabled={pending} className="btn-primary w-full py-3">
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
