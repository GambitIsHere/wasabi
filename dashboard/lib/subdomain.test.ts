// ============================================================================
// subdomain.ts — behavioural tests for host → candidate-org-slug resolution.
// ----------------------------------------------------------------------------
// Pure function, no I/O — mirrors lib/rate-limit.test.ts / lib/tenant.test.ts's
// plain-assertion style. Covers every host shape Batch D-a's header comment
// promises (see middleware.ts + lib/subdomain.ts), including the two
// query-override host families and the hosts that must NEVER honour one.
// ============================================================================
import { describe, expect, it } from "vitest";
import {
  LEGACY_PRODUCTION_HOST,
  PLATFORM_ROOT_DOMAIN,
  RESERVED_SUBDOMAINS,
  resolveOrgSlugFromHost,
} from "@/lib/subdomain";
import { SANJOW_ORG_ID } from "@/lib/tenant";

describe("resolveOrgSlugFromHost — the real multi-tenant pattern", () => {
  it("resolves <slug>.optimiser.pro to the slug", () => {
    expect(resolveOrgSlugFromHost("sanjow.optimiser.pro", null, false)).toEqual({
      slug: "sanjow",
      source: "platform-subdomain",
    });
  });

  it("lowercases the slug", () => {
    expect(resolveOrgSlugFromHost("SanJow.optimiser.pro", null, false).slug).toBe("sanjow");
  });

  it("strips a port before parsing", () => {
    expect(resolveOrgSlugFromHost("sanjow.optimiser.pro:443", null, false).slug).toBe("sanjow");
  });

  it("treats the bare apex domain as no tenant", () => {
    expect(resolveOrgSlugFromHost(PLATFORM_ROOT_DOMAIN, null, false)).toEqual({
      slug: null,
      source: "unresolvable",
    });
  });

  it.each([...RESERVED_SUBDOMAINS])(
    "never treats the reserved subdomain %s as an org slug",
    (reserved) => {
      expect(resolveOrgSlugFromHost(`${reserved}.optimiser.pro`, null, false)).toEqual({
        slug: null,
        source: "unresolvable",
      });
    },
  );

  it("refuses a multi-level subdomain rather than guessing which label is the org", () => {
    expect(resolveOrgSlugFromHost("foo.bar.optimiser.pro", null, false)).toEqual({
      slug: null,
      source: "unresolvable",
    });
  });

  it("does NOT honour ?org= on the real platform subdomain — the subdomain always wins", () => {
    expect(resolveOrgSlugFromHost("sanjow.optimiser.pro", "someone-else", false)).toEqual({
      slug: "sanjow",
      source: "platform-subdomain",
    });
  });

  it("an unregistered-looking slug still resolves as a CANDIDATE — existence is lib/org.ts's job", () => {
    // This module only reads the host; it can't know whether "ghost" is a
    // real org. That's the whole point of the split — see the module header.
    expect(resolveOrgSlugFromHost("ghost.optimiser.pro", null, false)).toEqual({
      slug: "ghost",
      source: "platform-subdomain",
    });
  });
});

describe("resolveOrgSlugFromHost — legacy production host", () => {
  it("resolves wasabi.sanjow-hub.com to sanjow unconditionally", () => {
    expect(resolveOrgSlugFromHost(LEGACY_PRODUCTION_HOST, null, false)).toEqual({
      slug: SANJOW_ORG_ID,
      source: "legacy-host",
    });
  });

  it("ignores ?org= on the legacy host — it can't be redirected to another tenant", () => {
    expect(resolveOrgSlugFromHost(LEGACY_PRODUCTION_HOST, "other-org", false).slug).toBe(
      SANJOW_ORG_ID,
    );
  });

  it("resolves regardless of isDev", () => {
    expect(resolveOrgSlugFromHost(LEGACY_PRODUCTION_HOST, null, true).slug).toBe(SANJOW_ORG_ID);
  });
});

describe("resolveOrgSlugFromHost — local dev", () => {
  it("bare localhost defaults to sanjow when isDev", () => {
    expect(resolveOrgSlugFromHost("localhost", null, true)).toEqual({
      slug: "sanjow",
      source: "dev-default",
    });
  });

  it("bare localhost is unresolvable when NOT isDev — no silent Sanjow default off a spoofable host", () => {
    expect(resolveOrgSlugFromHost("localhost", null, false)).toEqual({
      slug: null,
      source: "unresolvable",
    });
  });

  it("127.0.0.1 behaves the same as localhost", () => {
    expect(resolveOrgSlugFromHost("127.0.0.1", null, true).slug).toBe("sanjow");
    expect(resolveOrgSlugFromHost("127.0.0.1", null, false).slug).toBeNull();
  });

  it("?org= overrides the bare-localhost default when isDev", () => {
    expect(resolveOrgSlugFromHost("localhost:3000", "acme", true)).toEqual({
      slug: "acme",
      source: "dev-query-override",
    });
  });

  it("?org= on bare localhost is ignored when NOT isDev", () => {
    expect(resolveOrgSlugFromHost("localhost", "acme", false)).toEqual({
      slug: null,
      source: "unresolvable",
    });
  });

  it("<slug>.localhost mirrors the production subdomain pattern, regardless of isDev", () => {
    expect(resolveOrgSlugFromHost("sanjow.localhost:3000", null, false)).toEqual({
      slug: "sanjow",
      source: "dev-subdomain",
    });
    expect(resolveOrgSlugFromHost("acme.localhost", null, true).slug).toBe("acme");
  });

  it("reserved words are still reserved on <sub>.localhost", () => {
    expect(resolveOrgSlugFromHost("admin.localhost", null, true)).toEqual({
      slug: null,
      source: "unresolvable",
    });
  });
});

describe("resolveOrgSlugFromHost — Vercel preview URLs", () => {
  it("defaults to sanjow with no ?org=", () => {
    expect(resolveOrgSlugFromHost("wasabi-git-feature-sanjow.vercel.app", null, false)).toEqual({
      slug: "sanjow",
      source: "vercel-preview-default",
    });
  });

  it("honours ?org= for previewing a specific tenant", () => {
    expect(resolveOrgSlugFromHost("wasabi-abc123.vercel.app", "acme", false)).toEqual({
      slug: "acme",
      source: "dev-query-override",
    });
  });

  it("is not gated by isDev — a real Vercel preview build runs with NODE_ENV=production", () => {
    expect(resolveOrgSlugFromHost("wasabi-abc123.vercel.app", null, false).slug).toBe("sanjow");
  });

  // I7 — the production *.vercel.app alias is PUBLIC, so ?org= must not be an
  // ungated tenant-enumeration lever there.
  it("🔴 REFUSES ?org= on *.vercel.app when VERCEL_ENV=production (no tenant enumeration)", () => {
    expect(
      resolveOrgSlugFromHost("wasabi-abc123.vercel.app", "victim", false, "production"),
    ).toEqual({ slug: "sanjow", source: "vercel-preview-default" });
  });

  it("still honours ?org= on *.vercel.app for a PREVIEW deployment", () => {
    expect(
      resolveOrgSlugFromHost("wasabi-abc123.vercel.app", "acme", false, "preview"),
    ).toEqual({ slug: "acme", source: "dev-query-override" });
  });

  it("honours ?org= when VERCEL_ENV is unset (local/back-compat, the default arg)", () => {
    expect(resolveOrgSlugFromHost("wasabi-abc123.vercel.app", "acme", false).slug).toBe("acme");
  });
});

describe("resolveOrgSlugFromHost — unrecognised hosts", () => {
  it("returns null for a host this app has no pattern for", () => {
    expect(resolveOrgSlugFromHost("totally-unrelated-domain.com", null, false)).toEqual({
      slug: null,
      source: "unresolvable",
    });
  });

  it("returns null for an empty/missing host", () => {
    expect(resolveOrgSlugFromHost("", null, false).slug).toBeNull();
    expect(resolveOrgSlugFromHost(null, null, false).slug).toBeNull();
    expect(resolveOrgSlugFromHost(undefined, null, false).slug).toBeNull();
  });

  it("ignores ?org= on an unrecognised host — no dev/preview escape hatch applies", () => {
    expect(resolveOrgSlugFromHost("totally-unrelated-domain.com", "acme", true)).toEqual({
      slug: null,
      source: "unresolvable",
    });
  });
});
