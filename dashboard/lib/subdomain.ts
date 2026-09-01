// ============================================================================
// Subdomain → org-slug resolution (pure, Edge-safe, server + middleware).
// ----------------------------------------------------------------------------
// Optimiser.Pro is multi-tenant: each org gets a subdomain (`sanjow.optimiser.pro`).
// middleware.ts runs on the Edge and cannot query Postgres with the current
// driver setup (see lib/org.ts for the DB-backed half of this), so tenant
// resolution is split in two:
//   1. THIS module — a pure function, no I/O, no Next.js runtime dependency —
//      turns a Host header (+ a dev-only query override) into a CANDIDATE org
//      slug. It never touches the database, so it can run on the Edge and be
//      unit-tested with zero mocking.
//   2. lib/org.ts — server-only, DB-backed — takes the candidate slug this
//      module produces and decides whether it's a REAL org. That distinction
//      matters: this module can tell you "the host looks like it's naming org
//      X", never "org X exists". Only step 2 can say that, which is why an
//      unknown/nonexistent org slug is NOT rejected here — see lib/org.ts and
//      app/layout.tsx for where "unknown workspace" is actually decided.
//
// HEADER FORGERY: middleware.ts is the ONLY place ORG_SLUG_HEADER is ever SET.
// It always deletes any inbound copy first (see middleware.ts), so nothing a
// caller sends can reach server code as this header — every consumer of
// ORG_SLUG_HEADER downstream (lib/org.ts, auth.ts) can trust it completely.
//
// HOST PATTERNS THIS RESOLVES, IN ORDER:
//   1. wasabi.sanjow-hub.com   → "sanjow", unconditionally (today's production
//      host, back-compat — this is a real, permanent exception, not a dev one).
//   2. localhost / 127.0.0.1   → dev-only. `?org=` wins if present; otherwise
//      defaults to "sanjow" for a zero-config `npm run dev` (see LOCAL-DEV.md).
//      Gated on `isDev` (middleware.ts passes USE_LOCAL_PG==='1') so a request
//      that somehow arrives at a deployed instance with a spoofed
//      `Host: localhost` header — real DNS/edge routing can't produce this,
//      but we don't rely on that — resolves to unknown, not Sanjow.
//   3. <sub>.localhost         → dev-only subdomain form, e.g. sanjow.localhost:3000,
//      mirroring the production pattern exactly. No isDev gate needed: this
//      shape can only arise from a developer's own OS resolving *.localhost to
//      loopback, never from real internet routing to a deployed instance.
//   4. <sub>.vercel.app        → Vercel preview/deployment URLs. Vercel owns
//      this naming (project-hash-team.vercel.app); it never encodes a tenant.
//      `?org=` lets you preview a specific tenant; otherwise defaults to
//      "sanjow" so "does it still work on a preview URL" keeps meaning what it
//      always has. Not gated on isDev — see the header comment above
//      `VERCEL_HOST_SUFFIX` for why that's safe.
//   5. <sub>.optimiser.pro     → the real multi-tenant pattern. sub is the
//      candidate org slug, UNLESS it's the bare apex (no tenant) or one of
//      RESERVED_SUBDOMAINS (www/app/api/admin — never treated as an org slug,
//      so a future org literally named "api" can never collide with the path
//      other code reserves that word for).
//   6. anything else           → unrecognised; no candidate slug.
// `?org=` is NEVER consulted for (1) or (5) — the real hosts. Forging a query
// param can't override a real subdomain or the legacy production host.
// ============================================================================

/** Subdomains that must never resolve to an org, no matter what org rows
 *  exist — reserved for the platform itself (marketing/apex redirects, a
 *  future cross-org "app" shell, the API surface, a future platform-admin
 *  area). Checked case-insensitively against the FIRST label only. */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  "www",
  "app",
  "api",
  "admin",
]);

/** Optimiser.Pro's own domain — the real multi-tenant pattern is
 *  `<org-slug>.${PLATFORM_ROOT_DOMAIN}`. */
export const PLATFORM_ROOT_DOMAIN = "optimiser.pro";

/** Today's production host, predating the optimiser.pro subdomain pattern.
 *  Permanent back-compat, not a migration shim with an expiry — see
 *  scripts/migrate-tenancy.ts and lib/tenant.ts for the same constant. */
export const LEGACY_PRODUCTION_HOST = "wasabi.sanjow-hub.com";

/** The org this batch's only real tenant resolves to on every "we don't have
 *  a real subdomain to read" host (legacy prod, bare localhost, vercel.app
 *  with no override). Intentionally the same value as lib/tenant.ts's
 *  SANJOW_ORG_ID — duplicated as a literal (not imported) so this module
 *  stays dependency-free and Edge-safe; lib/subdomain.test.ts pins the two
 *  against each other so they can't silently drift apart. */
const DEFAULT_LEGACY_ORG_SLUG = "sanjow";

/** Vercel gives every deployment (preview AND production-via-its-own-alias) a
 *  `*.vercel.app` URL alongside any custom domain. Traffic on a REAL custom
 *  domain (wasabi.sanjow-hub.com, *.optimiser.pro) never carries this Host —
 *  Vercel's edge routes by the domain the client actually used, and that's
 *  reflected verbatim in the Host header this function reads. So gating this
 *  branch is unnecessary: the only way to make this branch fire at all is to
 *  already be talking to a *.vercel.app host, which by construction can't be
 *  the production custom domain. See this module's header comment, case 4. */
const VERCEL_HOST_SUFFIX = ".vercel.app";

const LOCALHOST_SUFFIX = ".localhost";

/** The header middleware.ts sets after resolving the org slug — the ONLY
 *  channel downstream server code trusts for "which org is this request
 *  for". Shared constant so middleware.ts (the writer) and lib/org.ts (the
 *  reader) can't drift on the literal string. */
export const ORG_SLUG_HEADER = "x-wasabi-org-slug";

/** The query param dev/preview hosts may use to pick a tenant explicitly —
 *  see resolveOrgSlugFromHost's header comment. Never consulted on a real
 *  production host. */
export const ORG_QUERY_PARAM = "org";

export type OrgSlugSource =
  | "legacy-host" // wasabi.sanjow-hub.com, unconditional
  | "dev-default" // bare localhost/127.0.0.1, isDev only
  | "dev-query-override" // ?org= on a dev/preview host
  | "dev-subdomain" // sanjow.localhost
  | "vercel-preview-default" // *.vercel.app, no ?org=
  | "platform-subdomain" // <slug>.optimiser.pro
  | "unresolvable"; // apex, reserved word, multi-level, or an unrecognised host

export interface ResolvedHost {
  /** The candidate org slug this host names, or null when no candidate can
   *  be read off the host at all (apex domain, a reserved word, a malformed
   *  subdomain, or a host this function doesn't recognise). A non-null slug
   *  is NOT a guarantee the org exists — see this module's header comment. */
  slug: string | null;
  source: OrgSlugSource;
}

const UNRESOLVED: ResolvedHost = { slug: null, source: "unresolvable" };

function stripPort(host: string): string {
  const withoutPort = host.split(":")[0] ?? "";
  return withoutPort.toLowerCase().trim();
}

function normalizeSlug(raw: string): string {
  return raw.toLowerCase().trim();
}

/** Shared by the `.localhost` and `.optimiser.pro` branches: turn a subdomain
 *  LABEL (already split off its parent domain) into a ResolvedHost, applying
 *  the reserved-word and malformed-shape checks once instead of twice. */
function resolveLabel(label: string, source: OrgSlugSource): ResolvedHost {
  // Multi-level subdomains (foo.bar.optimiser.pro) aren't a supported shape —
  // guessing which label is the org slug would be worse than refusing.
  if (label.length === 0 || label.includes(".")) return UNRESOLVED;
  if (RESERVED_SUBDOMAINS.has(label)) return UNRESOLVED;
  return { slug: normalizeSlug(label), source };
}

/**
 * Resolve the candidate org slug for one request's Host header.
 *
 * @param rawHost   The `Host` header, port included if present (e.g.
 *                   "sanjow.optimiser.pro" or "localhost:3000"). Read
 *                   directly off the incoming request — never a value
 *                   round-tripped through anything client-controlled beyond
 *                   the Host header itself.
 * @param queryOrg   The `?org=` query param, if present. Only ever consulted
 *                   for dev/preview hosts — see the module header. Pass the
 *                   raw string; this function lowercases/trims it.
 * @param isDev      Whether bare localhost/127.0.0.1 (no `?org=`) should
 *                   default to Sanjow. middleware.ts passes
 *                   `process.env.USE_LOCAL_PG === "1"` — the same flag
 *                   lib/db.ts and the rest of local dev already gates on,
 *                   absent in every deployed environment (see LOCAL-DEV.md).
 * @param vercelEnv  The value of `process.env.VERCEL_ENV` ("production" |
 *                   "preview" | "development" | undefined). Passed rather than
 *                   read here so this function stays pure/Edge-safe/testable.
 *                   Used ONLY to REFUSE the `?org=` tenant override on a
 *                   `*.vercel.app` host in PRODUCTION — Vercel gives production
 *                   a public `*.vercel.app` alias, so an ungated `?org=` there
 *                   would let anyone enumerate any tenant (`?org=victim`). On
 *                   preview/dev it stays honoured (previewing a tenant is its
 *                   whole point). Never consulted for any other host.
 */
export function resolveOrgSlugFromHost(
  rawHost: string | null | undefined,
  queryOrg: string | null | undefined,
  isDev: boolean,
  vercelEnv?: string | null,
): ResolvedHost {
  const host = stripPort(rawHost ?? "");
  if (host.length === 0) return UNRESOLVED;

  const trimmedQueryOrg = queryOrg?.trim();

  // 1. Back-compat production host — always Sanjow, any env, no override.
  if (host === LEGACY_PRODUCTION_HOST) {
    return { slug: DEFAULT_LEGACY_ORG_SLUG, source: "legacy-host" };
  }

  // 2. Bare localhost / 127.0.0.1 — dev convenience only (see isDev's doc above).
  if (host === "localhost" || host === "127.0.0.1") {
    if (!isDev) return UNRESOLVED;
    if (trimmedQueryOrg) {
      return { slug: normalizeSlug(trimmedQueryOrg), source: "dev-query-override" };
    }
    return { slug: DEFAULT_LEGACY_ORG_SLUG, source: "dev-default" };
  }

  // 3. <sub>.localhost — always parsed (see VERCEL_HOST_SUFFIX-style reasoning
  //    in the module header: this shape can't arise from real routing to a
  //    deployed instance, so no isDev gate is needed to keep it safe).
  if (host.endsWith(LOCALHOST_SUFFIX)) {
    const label = host.slice(0, -LOCALHOST_SUFFIX.length);
    return resolveLabel(label, "dev-subdomain");
  }

  // 4. Vercel preview/deployment URLs — see VERCEL_HOST_SUFFIX's header comment.
  //    The `?org=` override is honoured on preview/dev (choosing a tenant to
  //    preview) but REFUSED in production: a production `*.vercel.app` alias is
  //    public, so an ungated `?org=victim` there would enumerate any tenant.
  if (host.endsWith(VERCEL_HOST_SUFFIX)) {
    if (trimmedQueryOrg && vercelEnv !== "production") {
      return { slug: normalizeSlug(trimmedQueryOrg), source: "dev-query-override" };
    }
    return { slug: DEFAULT_LEGACY_ORG_SLUG, source: "vercel-preview-default" };
  }

  // 5. The real pattern: <slug>.optimiser.pro. Bare apex = no tenant.
  if (host === PLATFORM_ROOT_DOMAIN) return UNRESOLVED;
  const platformSuffix = `.${PLATFORM_ROOT_DOMAIN}`;
  if (host.endsWith(platformSuffix)) {
    const label = host.slice(0, -platformSuffix.length);
    return resolveLabel(label, "platform-subdomain");
  }

  // 6. Anything else — a host this app doesn't otherwise recognise.
  return UNRESOLVED;
}
