// ============================================================================
// Password strength policy — the PURE half of lib/password.ts.
// ----------------------------------------------------------------------------
// Split out specifically so client components (components/RegisterForm.tsx)
// can import MIN_PASSWORD_LENGTH / validatePasswordStrength WITHOUT pulling
// in lib/password.ts's hashing code — that file guards itself with `if
// (typeof window !== "undefined") throw`, AND imports @node-rs/argon2 (a
// native Node binary), so a client bundle that reached it would crash on
// load. Mirrors lib/metrics.ts / lib/metrics-core.ts's existing split for
// exactly the same reason — see that file's header comment.
//
// lib/password.ts re-exports everything below, so server-side callers
// (app/api/register/route.ts, lib/password.test.ts) can keep importing from
// "@/lib/password" unchanged; only the client-facing import
// (components/RegisterForm.tsx) needs to reach into this file directly.
// ============================================================================

/** Hard floor — enforced both here (source of truth) and restated in the
 *  register form's helper text (components/RegisterForm.tsx) so the rule is
 *  never a surprise discovered only after submitting. */
export const MIN_PASSWORD_LENGTH = 12;

// A short, hand-picked list of passwords that trivially clear the length bar
// (12+ chars) but are still guessed in seconds by any real attacker — the
// classic "keyboard-walk" and "word+padding" patterns. This is NOT an
// exhaustive breached-password list (that's a much bigger, separately-sourced
// dataset, e.g. HaveIBeenPwned's range API — out of scope for this batch);
// it exists to catch the handful of patterns someone will reach for FIRST
// when a form merely demands "12 characters".
const COMMON_WEAK_PASSWORDS = [
  "password1234",
  "password123!",
  "passw0rd1234",
  "qwertyuiop12",
  "qwertyuiopas",
  "letmein12345",
  "welcome12345",
  "iloveyou1234",
  "123456789012",
  "1234567890123",
  "12345678901234",
  "abcdefghijkl",
  "abcdefgh12345",
  "administrator",
  "changeme12345",
  "trustno1trustno1",
];

/** True when `s` is a single character repeated (e.g. "aaaaaaaaaaaa"). */
function isSingleRepeatedChar(s: string): boolean {
  return s.length > 0 && s.split("").every((c) => c === s[0]);
}

/** True when `s` is a run of strictly-sequential (ascending or descending,
 *  wraparound-free) character codes — "abcdefghijkl", "123456789012",
 *  "lkjihgfedcba". Catches keyboard/alphabet walks the blocklist can't
 *  enumerate. */
function isSequential(s: string): boolean {
  if (s.length < 4) return false;
  let ascending = true;
  let descending = true;
  for (let i = 1; i < s.length; i++) {
    const diff = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (diff !== 1) ascending = false;
    if (diff !== -1) descending = false;
  }
  return ascending || descending;
}

/**
 * Reject trivially weak passwords. Returns a user-facing error message, or
 * `null` when the password clears the bar. `email` (when known — registration
 * always knows it; nothing else calls this today) additionally blocks a
 * password equal to the account's own email or its local-part, case-insensitive.
 */
export function validatePasswordStrength(password: string, email?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  const lower = password.toLowerCase();

  if (isSingleRepeatedChar(lower)) {
    return "Password can't be a single repeated character.";
  }
  if (isSequential(lower)) {
    return "Password can't be a simple sequence (e.g. \"abcdefg\" or \"1234567\").";
  }
  if (COMMON_WEAK_PASSWORDS.includes(lower)) {
    return "That password is too common. Choose something less guessable.";
  }
  if (email) {
    const normalizedEmail = email.trim().toLowerCase();
    const localPart = normalizedEmail.split("@")[0] ?? "";
    if (lower === normalizedEmail || (localPart.length > 0 && lower === localPart)) {
      return "Password can't be your email address.";
    }
  }
  return null;
}
