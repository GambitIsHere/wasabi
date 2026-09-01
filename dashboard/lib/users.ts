// ============================================================================
// User accounts (server-only) — CRUD over the `user` table.
// ----------------------------------------------------------------------------
// Pure data access, no sign-in/registration POLICY here (mirrors lib/store.ts:
// the store is dumb, app/actions.ts decides what a "create" means). The policy
// lives in auth.ts (Google + Credentials sign-in) and app/register-actions.ts
// (self-registration + approval) — both funnel through the functions below so
// there's exactly one place that reads/writes the `user` table.
//
// EMAIL NORMALISATION: `user.email` is NOT NULL UNIQUE and always stored
// lowercased (lib/db.ts's header comment on the table). normalizeEmail() is
// the single place that lowercasing happens — every function below that takes
// or returns an email funnels through it, so "Alice@Sanjow.com" and
// "alice@sanjow.com" are always the same row.
// ============================================================================
import { createSchema, getSql } from "./db";
import { isUserStatus, type UserStatus } from "./roles";

// Defence-in-depth: never ship the DB layer to the browser.
if (typeof window !== "undefined") {
  throw new Error("lib/users.ts is server-only and must not run in the browser.");
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  /** Null for a Google-only user that has never set a password. */
  passwordHash: string | null;
  emailVerifiedAt: string | null;
  status: UserStatus;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  password_hash: string | null;
  email_verified_at: string | null;
  status: string;
  created_at: string;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    image: row.image,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
    // A status outside the known set can't come from lib/db.ts's schema
    // (DEFAULT 'pending', only ever written as one of USER_STATUSES below) —
    // fail closed to "suspended" rather than trust an unrecognised value as
    // something more privileged than intended, on the off chance a row was
    // ever written by hand.
    status: isUserStatus(row.status) ? row.status : "suspended",
    createdAt: row.created_at,
  };
}

/** The single place `user.email` gets lowercased — see this module's header. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export async function findUserByEmail(email: string): Promise<User | null> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT * FROM "user" WHERE email = ${normalizeEmail(email)}
  `) as unknown as UserRow[];
  const row = rows[0];
  return row ? toUser(row) : null;
}

export async function getUserById(id: string): Promise<User | null> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM "user" WHERE id = ${id}`) as unknown as UserRow[];
  const row = rows[0];
  return row ? toUser(row) : null;
}

export interface CreateUserInput {
  email: string;
  name?: string | null;
  image?: string | null;
  /** Omit (or null) for a Google-only account. */
  passwordHash?: string | null;
  status: UserStatus;
  /** ISO timestamp, or null/omitted for "not verified". */
  emailVerifiedAt?: string | null;
}

/**
 * Insert a brand-new user. Assumes the caller already checked email
 * uniqueness the way it wants to react to a collision (see
 * app/register-actions.ts, which pre-checks via findUserByEmail for a
 * friendly message AND still catches the UNIQUE constraint as a fallback for
 * the race between that check and this insert) — mirrors lib/store.ts's
 * insertExperiment, which documents the same division of labour.
 */
export async function createUser(input: CreateUserInput): Promise<User> {
  await createSchema();
  const sql = getSql();
  const id = crypto.randomUUID();
  const rows = (await sql`
    INSERT INTO "user" (id, email, name, image, password_hash, status, email_verified_at)
    VALUES (
      ${id},
      ${normalizeEmail(input.email)},
      ${input.name ?? null},
      ${input.image ?? null},
      ${input.passwordHash ?? null},
      ${input.status},
      ${input.emailVerifiedAt ?? null}
    )
    RETURNING *
  `) as unknown as UserRow[];
  const row = rows[0];
  if (!row) throw new Error("createUser: INSERT … RETURNING produced no row");
  return toUser(row);
}

/** Flip a user's status — the approval action's write (pending → active) and
 *  the only intended way to suspend an account. Returns the updated row, or
 *  null if `id` doesn't exist. */
export async function setUserStatus(id: string, status: UserStatus): Promise<User | null> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    UPDATE "user" SET status = ${status} WHERE id = ${id} RETURNING *
  `) as unknown as UserRow[];
  const row = rows[0];
  return row ? toUser(row) : null;
}

/** True when `err` is a Postgres unique-violation (SQLSTATE 23505) — the
 *  race-safety fallback for a duplicate email that slips past
 *  app/register-actions.ts's pre-check (see createUser's header comment), and
 *  reused by app/actions.ts's createExperiment + lib/archive.ts's
 *  upsertManyArchived to genericise a cross-tenant key collision (both share
 *  a GLOBAL primary key across tenants — see lib/tenant.ts's KNOWN
 *  LIMITATION note — so a duplicate-key error there can only mean another
 *  tenant already owns the key, which the raw Postgres message would
 *  otherwise confirm to the caller).
 *  Structural check (no `instanceof`, since the Neon driver doesn't export a
 *  typed error class) — a plain object with a `code` property is the
 *  documented shape Postgres wire errors surface as. When `code` is present
 *  it is authoritative (trusted over any message text). Only when it's ABSENT
 *  — some wrapper/driver path that doesn't carry `.code` — do we fall back to
 *  matching Postgres's own unique-violation wording, which is stable across
 *  Postgres versions. */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code !== undefined) return code === "23505";
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /duplicate key value violates unique constraint/i.test(message);
}
