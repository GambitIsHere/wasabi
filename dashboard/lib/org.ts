// ============================================================================
// Organization lookups (server-only) — the DB-backed half of tenant resolution.
// ----------------------------------------------------------------------------
// lib/subdomain.ts turns a Host header into a CANDIDATE org slug with zero I/O
// (Edge-safe). This file is the other half: given that candidate, does a real
// org exist? Only this file can answer that — which is deliberate, see
// lib/subdomain.ts's header comment. `organization.id` IS the slug (e.g.
// "sanjow") — there is no separate slug column — so "by slug" and "by id" are
// the same lookup; getOrgBySlug exists as a distinctly-named alias purely for
// call-site readability (resolving a Host header reads as "by slug", not "by
// id", even though it's the identical query).
//
// SERVER-ONLY: imports lib/db.ts. resolveOrgFromRequestHeader additionally
// imports next/headers, so it only works inside a Server Component / Route
// Handler / Server Action request context — never call it from a plain
// function/test without that context (lib/subdomain.test.ts covers the pure
// parsing this builds on instead).
// ============================================================================
import { headers } from "next/headers";
import { createSchema, getSql } from "./db";
import { ORG_SLUG_HEADER } from "./subdomain";

// Defence-in-depth: never ship the DB layer to the browser.
if (typeof window !== "undefined") {
  throw new Error("lib/org.ts is server-only and must not run in the browser.");
}

export interface Organization {
  id: string;
  name: string;
  /** The domain Google/password sign-in restricts to for this org (e.g.
   *  "sanjow.com"). Null means "no domain configured" — see auth.ts, which
   *  fails closed (rejects every sign-in/registration) in that case rather
   *  than treating a missing domain as "allow anything". */
  verifiedDomain: string | null;
  createdAt: string;
}

interface OrganizationRow {
  id: string;
  name: string;
  verified_domain: string | null;
  created_at: string;
}

function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    verifiedDomain: row.verified_domain,
    createdAt: row.created_at,
  };
}

/** One organization by its id (== its slug), or null if none exists. This is
 *  THE existence check lib/subdomain.ts can't do — a candidate slug that
 *  doesn't resolve here is what app/layout.tsx renders "unknown workspace"
 *  for (see resolveTenantForRequest in lib/tenant.ts). */
export async function getOrgById(id: string): Promise<Organization | null> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT id, name, verified_domain, created_at FROM organization WHERE id = ${id}
  `) as unknown as OrganizationRow[];
  const row = rows[0];
  return row ? toOrganization(row) : null;
}

/** Alias of getOrgById for call-site clarity — see this module's header. */
export const getOrgBySlug = getOrgById;

/** The first project row for `orgId` (by created_at), or null if it has
 *  none yet. lib/tenant.ts's getCurrentTenant() uses this for every org
 *  EXCEPT Sanjow (which short-circuits to the known SANJOW_DEFAULT_PROJECT_ID
 *  constant with zero I/O — see that file). Per-org project PROVISIONING
 *  (creating this row for a brand-new org) is out of scope for Batch D-a —
 *  see lib/tenant.ts's header comment; this is a plain read of whatever
 *  exists. */
export async function getFirstProjectIdForOrg(orgId: string): Promise<string | null> {
  await createSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT id FROM project WHERE org_id = ${orgId} ORDER BY created_at ASC LIMIT 1
  `) as unknown as { id: string }[];
  return rows[0]?.id ?? null;
}

/**
 * The candidate org slug middleware.ts resolved for THIS request, read off the
 * trusted header with ZERO I/O — no database round-trip, unlike
 * resolveOrgFromRequestHeader below. Returns null when middleware couldn't read
 * a candidate slug off the Host at all (apex, reserved word, unrecognised host).
 *
 * A non-null slug is a CANDIDATE, not proof the org exists — the existence check
 * is getOrgBySlug's job. This exists so a caller that already trusts an org id
 * (lib/tenant.ts's session fast path) can cheaply tell "does this host even name
 * a DIFFERENT org than the one I already trust?" before paying for a DB lookup:
 * organization.id IS the slug (see this module's header), so the header slug can
 * be compared directly against a known org id with no query.
 *
 * Same trust boundary as resolveOrgFromRequestHeader — see its comment below.
 */
export async function readOrgSlugHeader(): Promise<string | null> {
  const h = await headers();
  return h.get(ORG_SLUG_HEADER);
}

/**
 * Read the org slug middleware.ts resolved for THIS request off the trusted
 * header, and look it up. Returns null when either step comes up empty:
 * no header (middleware couldn't read a candidate slug off the Host at all)
 * or a header naming a slug that isn't a real org — both cases are
 * indistinguishable to the caller on purpose, since both mean the same
 * thing: "we don't know what workspace this is."
 *
 * Trust boundary: this reads ORG_SLUG_HEADER at face value. That's safe only
 * because middleware.ts unconditionally deletes any inbound copy of this
 * header before setting its own — see middleware.ts and lib/subdomain.ts's
 * header comment. Any code path that could reach this function WITHOUT first
 * passing through middleware (there is none today — the matcher in
 * middleware.ts's `config` covers every route except Next internals/static
 * assets) would break that guarantee.
 */
export async function resolveOrgFromRequestHeader(): Promise<Organization | null> {
  const slug = await readOrgSlugHeader();
  if (!slug) return null;
  return getOrgBySlug(slug);
}
