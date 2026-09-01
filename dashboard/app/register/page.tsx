// ============================================================================
// /register — email + password self-registration.
// ----------------------------------------------------------------------------
// Server component: resolves the org the same way /signin does
// (getResolvedOrgOrThrow — see lib/tenant.ts) purely for DISPLAY (stating the
// allowed domain up front, before anyone types anything). The actual
// enforcement of that domain restriction happens server-side again, from
// scratch, in app/api/register/route.ts — this page's org resolution is a
// courtesy to the user, not a security boundary (see that route's header
// comment: it never trusts anything the client sends for this).
// ============================================================================
import Link from "next/link";
import { RegisterForm } from "@/components/RegisterForm";
// The pure policy module, not "@/lib/password" — see that file's header on
// why only the client-safe half should ever be imported where it isn't
// strictly necessary to touch the hashing code.
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";
import { getResolvedOrgOrThrow } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const org = await getResolvedOrgOrThrow();
  const allowedDomain = org.verifiedDomain;

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-md space-y-8 rounded-2xl border border-line bg-bg-deep p-8 shadow-[0_24px_64px_-32px_rgba(0,0,0,0.4)]">
        <div className="space-y-3 text-center">
          <div className="text-4xl" aria-hidden="true">🌶</div>
          <p className="eyebrow">Register</p>
          <h1 className="font-display text-2xl font-bold tracking-tight text-fg">
            Join <span className="serif-accent">{org.name}</span>
          </h1>
          {allowedDomain ? (
            <p className="text-sm text-muted">
              Restricted to{" "}
              <code className="font-mono text-xs text-accent/90">@{allowedDomain}</code>{" "}
              addresses. Password must be at least{" "}
              <span className="text-fg">{MIN_PASSWORD_LENGTH} characters</span>.
            </p>
          ) : (
            <p className="text-sm text-bad">
              Self-registration isn&apos;t configured for this workspace yet — no verified
              domain is set. Ask an existing member to invite you, or sign in with Google if
              your account already exists.
            </p>
          )}
        </div>

        {allowedDomain && <RegisterForm allowedDomain={allowedDomain} />}

        <p className="text-center text-sm text-muted">
          Already have an account?{" "}
          <Link href="/signin" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
