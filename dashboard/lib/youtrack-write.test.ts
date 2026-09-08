// ============================================================================
// youtrack-write.ts — the write path's GATING is the contract under test.
// ----------------------------------------------------------------------------
// The module reads its env at import time, so each case resets the module
// registry, sets the env, and imports a fresh copy. The critical guarantees:
//   * NOT configured (missing token OR missing kill-switch) → ytWriteConfigured
//     is false and every mutating call throws YouTrackWriteError — the fail-safe
//     that keeps read/surface/promote/readiness working without a write token.
//   * configured → the base URL reconciles YOUTRACK_BASE_URL over YOUTRACK_HOST,
//     and a create actually sends a Bearer request past the guard.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "YOUTRACK_TOKEN",
  "WASABI_YT_WRITE_ENABLED",
  "YOUTRACK_BASE_URL",
  "YOUTRACK_HOST",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

async function load() {
  return import("@/lib/youtrack-write");
}

describe("ytWriteConfigured — the two-gate fail-safe", () => {
  it("is false with neither token nor kill-switch, and names both", async () => {
    const m = await load();
    expect(m.ytWriteConfigured()).toBe(false);
    expect(m.ytWriteDisabledReason()).toMatch(/YOUTRACK_TOKEN/);
    expect(m.ytWriteDisabledReason()).toMatch(/WASABI_YT_WRITE_ENABLED/);
  });

  it("is false with a token but no kill-switch (a read token is not enough)", async () => {
    process.env.YOUTRACK_TOKEN = "perm-abc";
    const m = await load();
    expect(m.ytWriteConfigured()).toBe(false);
    expect(m.ytWriteDisabledReason()).toMatch(/switched off|WASABI_YT_WRITE_ENABLED/);
  });

  it("is false with the kill-switch on but no token", async () => {
    process.env.WASABI_YT_WRITE_ENABLED = "1";
    const m = await load();
    expect(m.ytWriteConfigured()).toBe(false);
    expect(m.ytWriteDisabledReason()).toMatch(/YOUTRACK_TOKEN/);
  });

  it("is true only with BOTH the token and the kill-switch", async () => {
    process.env.YOUTRACK_TOKEN = "perm-abc";
    process.env.WASABI_YT_WRITE_ENABLED = "1";
    const m = await load();
    expect(m.ytWriteConfigured()).toBe(true);
    expect(m.ytWriteDisabledReason()).toBeNull();
  });
});

describe("mutating calls throw when not configured", () => {
  it("createIssue throws YouTrackWriteError with no token/switch (never hits the network)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const m = await load();
    await expect(
      m.createIssue({ projectId: "0-1", summary: "s", description: "d" }),
    ).rejects.toBeInstanceOf(m.YouTrackWriteError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("listProjects and addWatcher throw when not configured", async () => {
    const m = await load();
    await expect(m.listProjects()).rejects.toBeInstanceOf(m.YouTrackWriteError);
    await expect(m.addWatcher("GP-1", "someone")).rejects.toBeInstanceOf(m.YouTrackWriteError);
  });
});

describe("base URL reconcile", () => {
  it("prefers YOUTRACK_BASE_URL over YOUTRACK_HOST", async () => {
    process.env.YOUTRACK_BASE_URL = "https://base.youtrack.cloud";
    process.env.YOUTRACK_HOST = "host.youtrack.cloud";
    const m = await load();
    expect(m.YT_WRITE_BASE).toBe("https://base.youtrack.cloud");
  });

  it("falls back to YOUTRACK_HOST when BASE_URL is unset", async () => {
    process.env.YOUTRACK_HOST = "host.youtrack.cloud";
    const m = await load();
    expect(m.YT_WRITE_BASE).toBe("https://host.youtrack.cloud");
  });
});

describe("configured create sends a Bearer request past the guard", () => {
  it("POSTs to the write base with the token and returns the readable id", async () => {
    process.env.YOUTRACK_TOKEN = "perm-xyz";
    process.env.WASABI_YT_WRITE_ENABLED = "1";
    process.env.YOUTRACK_BASE_URL = "https://sanjow.youtrack.cloud";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ id: "2-1", idReadable: "GP-742" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const m = await load();
    const created = await m.createIssue({
      projectId: "0-12",
      summary: "TU | Build variant",
      description: "body",
    });
    expect(created.idReadable).toBe("GP-742");
    expect(created.url).toBe("https://sanjow.youtrack.cloud/issue/GP-742");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("https://sanjow.youtrack.cloud/api/issues");
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer perm-xyz",
    );
    expect((init as { method: string }).method).toBe("POST");
  });
});
