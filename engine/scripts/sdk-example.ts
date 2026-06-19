// Self-contained demo + smoke test for the client SDK — NO live server needed.
// We stub `globalThis.fetch` with a tiny fake that answers /decide with a canned
// DecideResponse and /capture with `{status:1}`, then drive the real SDK through
// it and assert the PostHog-shaped contract holds (values, caching, capture).
// Run: `node scripts/sdk-example.ts`  (Node 25 runs TS directly via type-stripping.)
import { createWasabi } from "../src/sdk.ts";
import type { DecideResponse, CaptureResponse } from "../src/wire.ts";

// The canned /decide payload — the real TU £19 UK test: user is in `variant_19`,
// which the engine maps to the `tu_lov_uk_19` storefront theme.
const DECIDE: DecideResponse = {
  featureFlags: { "tu-billing-uk": "variant_19" },
  themes: { "tu-billing-uk": "tu_lov_uk_19" },
};
const CAPTURE_OK: CaptureResponse = { status: 1 };

// Count calls per path so we can prove the /decide response is cached (PostHog-style):
// many flag reads, but the network is hit exactly once.
const calls = { decide: 0, capture: 0 };

// Stub the global fetch. We only need the bits the SDK uses: ok, status, json().
globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
  const url = String(input);
  if (url.endsWith("/decide")) {
    calls.decide++;
    return jsonResponse(DECIDE);
  }
  if (url.endsWith("/capture")) {
    calls.capture++;
    return jsonResponse(CAPTURE_OK);
  }
  throw new Error(`unexpected fetch to ${url}`);
}) as typeof fetch;

/** Minimal Response-like object exposing the fields the SDK reads. */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  } as Response;
}

let failures = 0;
const ok = (label: string, pass: boolean) => {
  console.log(`  ${pass ? "✓" : "✗"} ${label}`);
  if (!pass) failures++;
};

async function main(): Promise<void> {
  const wasabi = createWasabi({ host: "https://wasabi.test", distinctId: "cust_abc123" });

  console.log("\n1. Flag reads return the variant from /decide");
  const flag = await wasabi.getFeatureFlag("tu-billing-uk");
  ok(`getFeatureFlag("tu-billing-uk") → "${flag}" (expected "variant_19")`, flag === "variant_19");

  const enabled = await wasabi.isFeatureEnabled("tu-billing-uk");
  ok(`isFeatureEnabled("tu-billing-uk") → ${enabled} (expected true)`, enabled === true);

  const theme = await wasabi.getTheme("tu-billing-uk");
  ok(`getTheme("tu-billing-uk") → "${theme}" (expected "tu_lov_uk_19")`, theme === "tu_lov_uk_19");

  console.log("\n2. Caching — many reads, ONE /decide call");
  await wasabi.getAllFlags();
  await wasabi.getFeatureFlag("tu-billing-uk");
  await wasabi.isFeatureEnabled("tu-billing-uk");
  ok(`/decide hit exactly once across ${"" + 5} reads (got ${calls.decide})`, calls.decide === 1);

  console.log("\n3. reload() busts the cache");
  wasabi.reload();
  await wasabi.getFeatureFlag("tu-billing-uk");
  ok(`/decide refetched after reload (got ${calls.decide}, expected 2)`, calls.decide === 2);

  console.log("\n4. Unknown flag defaults to false (PostHog contract)");
  const missing = await wasabi.getFeatureFlag("not-a-flag");
  ok(`getFeatureFlag("not-a-flag") → ${missing} (expected false)`, missing === false);

  console.log("\n5. capture() resolves and hits /capture");
  await wasabi.capture("checkout_started", { value: 19 });
  ok(`capture("checkout_started") resolved; /capture hit ${calls.capture}× (expected 1)`, calls.capture === 1);

  console.log("\n6. Missing distinctId throws a clear error");
  const noId = createWasabi({ host: "https://wasabi.test" });
  let threw = false;
  try {
    await noId.getFeatureFlag("tu-billing-uk");
  } catch (err) {
    threw = err instanceof Error && err.message.includes("distinctId");
  }
  ok("getFeatureFlag without any distinctId throws", threw);

  console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
