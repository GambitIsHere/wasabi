// ============================================================================
// domain-restriction.ts — behavioural tests for the shared email/domain
// check backing both Google sign-in (auth.config.ts) and password
// self-registration (app/api/register/route.ts).
// ============================================================================
import { describe, expect, it } from "vitest";
import { emailMatchesDomain, normalizeDomain } from "@/lib/domain-restriction";

describe("emailMatchesDomain", () => {
  it("accepts an email on the allowed domain", () => {
    expect(emailMatchesDomain("alice@sanjow.com", "sanjow.com")).toBe(true);
  });

  it("rejects an email on a different domain", () => {
    expect(emailMatchesDomain("alice@evil.com", "sanjow.com")).toBe(false);
  });

  it("rejects a domain that merely ends with the allowed domain as a substring, not a real subdomain match", () => {
    // "alice@notsanjow.com" ends with "sanjow.com" as raw characters but is
    // NOT "@sanjow.com" — the leading "@" in the comparison is what makes
    // this correctly reject rather than a bare .endsWith("sanjow.com").
    expect(emailMatchesDomain("alice@notsanjow.com", "sanjow.com")).toBe(false);
  });

  it("does NOT match a subdomain of the allowed domain — exact domain only, by design", () => {
    // "mail.sanjow.com" is not "sanjow.com": this is a plain "@<domain>"
    // suffix match, not a subdomain-aware comparison, matching the task's
    // requirement literally ("restricted to @sanjow.com addresses") without
    // silently widening it to the whole domain tree.
    expect(emailMatchesDomain("alice@mail.sanjow.com", "sanjow.com")).toBe(false);
  });

  it("is case-insensitive on both sides", () => {
    expect(emailMatchesDomain("Alice@Sanjow.COM", "SANJOW.com")).toBe(true);
  });

  it("tolerates surrounding whitespace on the email", () => {
    expect(emailMatchesDomain("  alice@sanjow.com  ", "sanjow.com")).toBe(true);
  });

  it("tolerates a domain stored with a leading @", () => {
    expect(emailMatchesDomain("alice@sanjow.com", "@sanjow.com")).toBe(true);
  });

  it("rejects everything when the domain is empty — never a silent allow-all", () => {
    expect(emailMatchesDomain("alice@sanjow.com", "")).toBe(false);
    expect(emailMatchesDomain("alice@sanjow.com", "   ")).toBe(false);
  });
});

describe("normalizeDomain", () => {
  it("lowercases and trims", () => {
    expect(normalizeDomain("  Sanjow.COM  ")).toBe("sanjow.com");
  });

  it("strips a leading @", () => {
    expect(normalizeDomain("@sanjow.com")).toBe("sanjow.com");
  });
});
