// ============================================================================
// /signin — Google button (unchanged) + a new email/password form.
// ----------------------------------------------------------------------------
// Server component. The org this page signs into is RESOLVED, not assumed —
// getResolvedOrgOrThrow() (lib/tenant.ts) reads the subdomain (or the
// session, for the edge case of an already-signed-in user landing here) and
// throws if neither works; that throw should be unreachable here because
// app/layout.tsx's gate already rendered "unknown workspace" instead of this
// page for that case (see lib/tenant.ts's header comment on the resolution
// order).
//
// The Google form posts to an inline server action exactly as before this
// batch. The password form's action ALSO needs to catch a thrown
// CredentialsSignin (auth.ts's authorize() throws rather than redirecting
// when called from a Server Action — see that file's header comment) and
// turn it into the SAME ?error=&code= shape Auth.js's own OAuth error
// redirect already uses, so SignInError below handles both under one
// mechanism.
// ============================================================================
import Link from "next/link";
import { redirect } from "next/navigation";
import { CredentialsSignin } from "next-auth";
import { signIn } from "@/auth";
import { getResolvedOrgOrThrow } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; code?: string; callbackUrl?: string }>;
}) {
  const { error, code, callbackUrl } = await searchParams;
  const org = await getResolvedOrgOrThrow();
  const allowedDomain = org.verifiedDomain ?? process.env.AUTH_ALLOWED_EMAIL_DOMAIN ?? "sanjow.com";

  async function signInWithGoogle() {
    "use server";
    await signIn("google", { redirectTo: callbackUrl || "/" });
  }

  async function signInWithPassword(formData: FormData) {
    "use server";
    const email = formData.get("email");
    const password = formData.get("password");
    try {
      await signIn("credentials", {
        email: typeof email === "string" ? email : "",
        password: typeof password === "string" ? password : "",
        redirectTo: callbackUrl || "/",
      });
    } catch (err) {
      // Success also flows through this catch (Next's internal redirect
      // signal is an exception) — only a genuine CredentialsSignin gets
      // turned into our own redirect; everything else (including the
      // success signal) is rethrown unchanged.
      if (err instanceof CredentialsSignin) {
        const params = new URLSearchParams({ error: "CredentialsSignin", code: err.code });
        if (callbackUrl) params.set("callbackUrl", callbackUrl);
        redirect(`/signin?${params.toString()}`);
      }
      throw err;
    }
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-md space-y-8 rounded-2xl border border-line bg-bg-deep p-8 shadow-[0_24px_64px_-32px_rgba(0,0,0,0.4)]">
        <div className="space-y-3 text-center">
          <div className="text-4xl" aria-hidden="true">🌶</div>
          <p className="eyebrow">Sign in</p>
          <h1 className="font-display text-2xl font-bold tracking-tight text-fg">
            Sign in to <span className="serif-accent">{org.name}</span>
          </h1>
          <p className="text-sm text-muted">
            Restricted to{" "}
            <code className="font-mono text-xs text-accent/90">
              @{allowedDomain}
            </code>{" "}
            accounts.
          </p>
        </div>

        {error && <SignInError error={error} code={code} allowedDomain={allowedDomain} />}

        <form action={signInWithGoogle}>
          <button type="submit" className="btn-primary w-full py-3">
            Continue with Google
          </button>
        </form>

        <div className="flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-line" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-faint">or</span>
          <span className="h-px flex-1 bg-line" />
        </div>

        <form action={signInWithPassword} className="space-y-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Email</span>
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
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
              autoComplete="current-password"
              className="rounded-lg border border-line-strong bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-lg border border-line-strong bg-surface py-2.5 text-sm font-medium text-fg transition-colors hover:border-accent/60 hover:text-accent focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          >
            Sign in with password
          </button>
        </form>

        <p className="text-center text-sm text-muted">
          No account yet?{" "}
          <Link href="/register" className="font-medium text-accent hover:underline">
            Register
          </Link>
        </p>

        <p className="text-center font-mono text-[10px] uppercase tracking-wider text-muted">
          You&apos;ll be redirected to Google to authenticate, or sign in directly with a password.
        </p>
      </div>
    </div>
  );
}

function SignInError({
  error,
  code,
  allowedDomain,
}: {
  error: string;
  code?: string;
  allowedDomain: string;
}) {
  // Auth.js maps internal errors to a few canonical codes — surface the ones
  // a user can act on; collapse the rest to a generic message. For
  // CredentialsSignin, `code` (set by auth.ts's InvalidCredentialsError /
  // RateLimitedError) picks the specific message — see auth.ts's header
  // comment on why "invalid_credentials" covers five different underlying
  // reasons with one indistinguishable message.
  const message =
    error === "AccessDenied"
      ? `That Google account isn't an @${allowedDomain} address, isn't active yet, or doesn't have access to this workspace. Sign out of Google and try a different account.`
      : error === "Configuration"
        ? "Sign-in is misconfigured server-side — check AUTH_* env vars."
        : error === "CredentialsSignin" && code === "rate_limited"
          ? "Too many sign-in attempts. Wait a minute and try again."
          : error === "CredentialsSignin"
            ? "Invalid email or password."
            : "Couldn't sign you in. Try again.";

  return (
    <div
      role="alert"
      className="rounded-lg border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad"
    >
      {message}
    </div>
  );
}
