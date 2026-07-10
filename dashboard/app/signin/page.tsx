import { signIn } from "@/auth";

// Branded sign-in page that replaces NextAuth's default. Server component;
// posts a server action that delegates to NextAuth's `signIn("google", …)`.
export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const { error, callbackUrl } = await searchParams;
  const allowedDomain = process.env.AUTH_ALLOWED_EMAIL_DOMAIN ?? "sanjow.com";

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-md space-y-8 rounded-2xl border border-line bg-bg-deep p-8 shadow-[0_24px_64px_-32px_rgba(0,0,0,0.4)]">
        <div className="space-y-3 text-center">
          <div className="text-4xl" aria-hidden="true">🌶</div>
          <p className="eyebrow">Internal admin</p>
          <h1 className="font-display text-2xl font-bold tracking-tight text-fg">
            Sign in to <span className="serif-accent">Wasabi</span>
          </h1>
          <p className="text-sm text-muted">
            Restricted to{" "}
            <code className="font-mono text-xs text-accent/90">
              @{allowedDomain}
            </code>{" "}
            Google accounts.
          </p>
        </div>

        {error && <SignInError error={error} allowedDomain={allowedDomain} />}

        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: callbackUrl || "/" });
          }}
        >
          <button type="submit" className="btn-primary w-full py-3">
            Continue with Google
          </button>
        </form>

        <p className="text-center font-mono text-[10px] uppercase tracking-wider text-muted">
          You&apos;ll be redirected to Google to authenticate.
        </p>
      </div>
    </div>
  );
}

function SignInError({
  error,
  allowedDomain,
}: {
  error: string;
  allowedDomain: string;
}) {
  // Auth.js maps internal errors to a few canonical codes — surface the ones
  // a user can act on; collapse the rest to a generic message.
  const message =
    error === "AccessDenied"
      ? `That Google account isn't an @${allowedDomain} address. Sign out of Google and try a different account.`
      : error === "Configuration"
        ? "Sign-in is misconfigured server-side — check AUTH_* env vars."
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
