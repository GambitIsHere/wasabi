// ============================================================================
// Password hashing (server-only) — the argon2id half. Strength-policy pure
// functions (MIN_PASSWORD_LENGTH, validatePasswordStrength) live in
// lib/password-policy.ts and are re-exported below — see that file's header
// for why the split exists (client-safety: this file cannot be imported from
// a client component).
// ----------------------------------------------------------------------------
// Backs the Credentials provider's registration + login flow (auth.ts,
// app/api/register/route.ts). hashPassword / verifyPassword use
// @node-rs/argon2 (a napi-rs native binding, prebuilt per platform, no
// node-gyp build step — works unmodified on Vercel's Node runtime the same
// way it does here). NEVER hand-roll a comparison: verifyPassword delegates
// to the library's own constant-time verify() so hashing and comparing can't
// drift apart.
//
// PARAMETERS (stated explicitly, not left implicit, so they're auditable from
// source and stable even if the library's own defaults ever change):
//   algorithm=Argon2id, memoryCost=19456 KiB (19 MiB), timeCost=2, parallelism=1
// — OWASP's Password Storage Cheat Sheet first recommendation for Argon2id.
// The resulting hash is a self-describing PHC string (e.g.
// "$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>"), so verifyPassword doesn't
// need to (and doesn't) re-pass these options — they're read back out of the
// stored hash itself. That also means a future policy change (e.g. bumping
// memoryCost) never invalidates already-hashed passwords.
// ============================================================================
import { hash, verify } from "@node-rs/argon2";

// Defence-in-depth: never ship the hashing layer to the browser.
if (typeof window !== "undefined") {
  throw new Error("lib/password.ts is server-only and must not run in the browser.");
}

export * from "./password-policy";

// No explicit `algorithm` field: @node-rs/argon2 exports Algorithm as a
// `const enum`, which this project's tsconfig (isolatedModules: true, the
// same setting that makes Next's per-file SWC/esbuild transpilation work)
// cannot reference — see https://www.typescriptlang.org/tsconfig#isolatedModules.
// Argon2id is the library's own default when `algorithm` is omitted (its
// Algorithm.Argon2id enum member is documented as "Default value" — verified
// empirically: `hash(pw, { memoryCost, timeCost, parallelism })` with no
// `algorithm` produces a `$argon2id$…` PHC string), so this still hashes
// with argon2id, just without naming the enum member directly.
const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Hash a plaintext password. Returns the full PHC-format string — store this
 *  verbatim in `user.password_hash`. Never log or persist the plaintext
 *  argument anywhere else. */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** Constant-time verify against a stored PHC hash. `storedHash` is untrusted
 *  input in shape only (it's our own DB column, but a corrupt/foreign value
 *  must fail closed, not throw past the caller) — a malformed hash string
 *  makes @node-rs/argon2 reject/throw, which this treats as "wrong password"
 *  rather than letting the error propagate into a 500 that could hint at
 *  which accounts have a usable hash at all. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}
