// ============================================================================
// POST /api/register — self-registration, domain-restricted per org.
// ----------------------------------------------------------------------------
// A Route Handler rather than a Server Action (the convention every other
// form in this app uses — see app/actions.ts) specifically so rate-limiting
// can return a literal HTTP 429, matching /api/capture's existing contract
// and the batch spec's explicit "returning 429". components/RegisterForm.tsx
// (client component) posts here via fetch.
//
// SECURITY (requirement 3):
//   - Rate-limited per IP (lib/rate-limit.ts), checked before anything else
//     is even parsed — 429 on exhaustion.
//   - Domain restriction is enforced against the SERVER-RESOLVED org
//     (lib/org.ts, via the trusted middleware-set header) — never a
//     client-supplied org id/domain. A request naming no resolvable org, or
//     an org with no verified_domain configured, is rejected — this endpoint
//     never guesses which domain to allow.
//   - Password: argon2id via lib/password.ts, same module the login path
//     uses — see that file's header for the exact parameters. Never logged;
//     the raw request body (which contains it) is never persisted or logged
//     either.
//   - 🔴 Every successful registration creates a "pending" user — never
//     "active". lib/password.ts's hashing happening correctly is necessary
//     but not sufficient for access: auth.ts's Credentials authorize()
//     independently re-checks status==='active' on every login attempt, so
//     even a bug in THIS file that somehow granted access some other way
//     still wouldn't produce a working session — see auth.ts's header.
//   - sendVerificationEmail() (lib/email-verification.ts) is best-effort and
//     never blocks or fails the registration itself — see that module's
//     header for why it always returns false in this batch (no provider
//     wired up) and what the response's `emailSent: false` means for the UI.
// ============================================================================
import { NextResponse } from "next/server";
import { getClientIp } from "@/lib/get-client-ip";
import { sendVerificationEmail } from "@/lib/email-verification";
import { emailMatchesDomain } from "@/lib/domain-restriction";
import { determineRoleForNewMembership, findOrCreateMembership } from "@/lib/membership";
import { resolveOrgFromRequestHeader } from "@/lib/org";
import { hashPassword, validatePasswordStrength } from "@/lib/password";
import { perMinute, takeToken } from "@/lib/rate-limit";
import { createUser, findUserByEmail, isUniqueViolation, normalizeEmail } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A tighter burst than login (5 vs 8) and a slower refill (2/min vs 4/min) —
// registration is rarer for a legitimate user than a login retry, and each
// successful attempt does real work (an argon2 hash + two DB writes), so
// there's less reason to allow a fast sustained rate here.
const REGISTER_RATE_LIMIT = { capacity: 5, refillPerMs: perMinute(2) };

const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface RegisterBody {
  email?: unknown;
  password?: unknown;
  confirmPassword?: unknown;
}

interface RegisterResponse {
  ok: boolean;
  error?: string;
  /** Present only when ok — whether a verification email actually sent (see
   *  lib/email-verification.ts). components/RegisterForm.tsx shows different
   *  copy depending on this. */
  emailSent?: boolean;
}

function fail(error: string, status: number): NextResponse<RegisterResponse> {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(request: Request): Promise<NextResponse<RegisterResponse>> {
  if (!takeToken(getClientIp(request), REGISTER_RATE_LIMIT)) {
    return fail("Too many attempts. Try again in a minute.", 429);
  }

  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return fail("Invalid request body.", 400);
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";

  if (!EMAIL_SHAPE_RE.test(email)) {
    return fail("Enter a valid email address.", 400);
  }
  if (password !== confirmPassword) {
    return fail("Passwords don't match.", 400);
  }
  const strengthError = validatePasswordStrength(password, email);
  if (strengthError) {
    return fail(strengthError, 400);
  }

  // The org this registration is FOR — resolved server-side from the trusted
  // subdomain header, never from anything in the request body. See this
  // file's header comment.
  const org = await resolveOrgFromRequestHeader();
  if (!org) {
    return fail("Couldn't determine which workspace to register for.", 400);
  }
  const allowedDomain = org.verifiedDomain;
  if (!allowedDomain) {
    return fail("Self-registration isn't configured for this workspace yet.", 400);
  }

  const normalizedEmail = normalizeEmail(email);
  if (!emailMatchesDomain(normalizedEmail, allowedDomain)) {
    return fail(`Registration is restricted to @${allowedDomain} addresses.`, 400);
  }

  // Pre-check for a friendly message (see lib/users.ts's createUser header
  // comment on why this — not the login flow's anti-enumeration rule —
  // applies to registration: covered explicitly in this batch's spec only
  // for LOGIN, and telling someone "you already have an account, sign in
  // instead" here is meaningfully better UX than a fake-success message).
  const existing = await findUserByEmail(normalizedEmail);
  if (existing) {
    return fail("An account with this email already exists. Sign in instead.", 409);
  }

  const passwordHash = await hashPassword(password);

  let user;
  try {
    user = await createUser({
      email: normalizedEmail,
      passwordHash,
      status: "pending", // 🔴 never "active" — see this file's header comment
    });
  } catch (err) {
    // Race-safety fallback for the check above (two concurrent registrations
    // for the same email) — see lib/users.ts's createUser header comment.
    if (isUniqueViolation(err)) {
      return fail("An account with this email already exists. Sign in instead.", 409);
    }
    throw err;
  }

  // The registrant is "pending" (created just above), so this never grants
  // owner — a self-registration can't bootstrap/claim a fresh org (I13). They
  // default to viewer and wait for an owner/admin to approve (and, if wanted,
  // promote) them via /admin/members.
  const role = await determineRoleForNewMembership(org.id, false);
  await findOrCreateMembership(user.id, org.id, role);

  const emailSent = await sendVerificationEmail({ id: user.id, email: user.email });

  return NextResponse.json({ ok: true, emailSent }, { status: 201 });
}
