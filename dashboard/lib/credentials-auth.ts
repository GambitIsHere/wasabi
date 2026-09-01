// ============================================================================
// Core credentials-check logic behind auth.ts's Credentials authorize().
// ----------------------------------------------------------------------------
// Extracted as a standalone function so it's unit-testable (lib/credentials-
// auth.test.ts) without going through Auth.js's actual provider/request
// machinery. auth.ts's authorize() is a thin wrapper that ALSO rate-limits
// (needs the raw Request, which this function deliberately does not take)
// and turns a null return into the specific thrown error Auth.js expects.
//
// Returns null for EVERY failure reason — no such user, no password set
// (Google-only account), wrong password, not "active" (pending/suspended),
// or no membership in `orgId` — and NEVER distinguishes which one. This is
// the requirement 3 anti-enumeration property ("a failed login must not
// reveal whether the account exists") made concrete: every one of these five
// genuinely different situations produces the exact same `null`, so nothing
// downstream (including a bug in the caller) can accidentally leak which one
// occurred by branching on a return value that doesn't carry that
// information in the first place.
//
// TIMING is equalised too, not just the return value: the "no such user" /
// "Google-only, no hash" path performs one throwaway argon2 verify against a
// fixed dummy hash before returning null, so it costs the same ~argon2 time as
// the "wrong password" path. Without that, a nonexistent account would answer
// measurably faster than a real one — a latency oracle that leaks which emails
// are registered.
// ============================================================================
import { getMembership } from "./membership";
import type { MembershipRole } from "./roles";
import { verifyPassword } from "./password";
import { findUserByEmail } from "./users";

/** A fixed, valid argon2id PHC string with the SAME params as lib/password.ts's
 *  real hashes — used ONLY to equalise timing on the no-user / no-hash path.
 *  Its plaintext is a throwaway nobody knows, so no password can ever verify
 *  against it; its only job is to make that path do the same argon2 work the
 *  real-user path does. */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$pZEWFOGyUKIC/qVNxsjY2g$xXbd7Pad6qTrqaXL8/Bh40XFqUVUFZCUaK1+ol7tCJY";

export interface AuthorizedCredentialsUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  orgId: string;
  role: MembershipRole;
}

export async function authorizeCredentials(
  email: string,
  password: string,
  orgId: string,
): Promise<AuthorizedCredentialsUser | null> {
  if (!email || !password) return null;

  const dbUser = await findUserByEmail(email);
  if (!dbUser || !dbUser.passwordHash) {
    // No such user, or a Google-only account with no password set. Do the same
    // argon2 work the real path does (against a throwaway hash) before failing,
    // so this branch isn't measurably faster — see this file's header on the
    // timing oracle. The result is intentionally discarded.
    await verifyPassword(DUMMY_PASSWORD_HASH, password);
    return null;
  }

  const validPassword = await verifyPassword(dbUser.passwordHash, password);
  if (!validPassword) return null;

  // 🔴 The core "unverified accounts must not get access" gate: "pending" (or
  // "suspended") gets exactly the same null as a wrong password.
  if (dbUser.status !== "active") return null;

  // Tenant isolation: a correct, active-account password does not imply
  // membership in THIS org.
  const membership = await getMembership(dbUser.id, orgId);
  if (!membership) return null;

  return {
    id: dbUser.id,
    email: dbUser.email,
    name: dbUser.name,
    image: dbUser.image,
    orgId,
    role: membership.role,
  };
}
