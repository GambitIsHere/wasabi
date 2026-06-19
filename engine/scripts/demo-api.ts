// Proof-of-life for the HTTP API layer — boots the real server on an
// OS-assigned port and drives it over the wire with `fetch`, exactly as a
// storefront would. Mirrors scripts/verify.ts's style (the `ok` helper, ✓/✗
// lines, exit code = pass/fail). Run: `node scripts/demo-api.ts`.
import type { AddressInfo } from "node:net";
import { createServer } from "../src/server.ts";
import type {
  CaptureResponse,
  DecideResponse,
  FlagsResponse,
} from "../src/wire.ts";

let failures = 0;
const ok = (label: string, pass: boolean): void => {
  console.log(`  ${pass ? "✓" : "✗"} ${label}`);
  if (!pass) failures++;
};

// Boot the server on port 0 → the OS hands us a free port, which we read back
// from the bound address. No fixed port = no "address in use" flakiness.
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, resolve));
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
console.log(`\nwasabi-engine demo — server on ${base}`);

/** POST helper: send JSON, parse JSON, return the typed body. */
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

// (a) Stickiness over the wire — same distinctId, two calls, identical variant.
console.log("\n(a) Stickiness — same user gets the same variant twice");
const id = "cust_abc123";
const first = await post<DecideResponse>("/decide", { distinctId: id });
const second = await post<DecideResponse>("/decide", { distinctId: id });
const v1 = first.featureFlags["tu-billing-uk"];
const v2 = second.featureFlags["tu-billing-uk"];
ok(`${id} → tu-billing-uk="${String(v1)}" on both calls`, v1 === v2);
ok(
  `${id} → theme="${first.themes["tu-billing-uk"] ?? "(default)"}" is stable`,
  first.themes["tu-billing-uk"] === second.themes["tu-billing-uk"],
);

// (b) Distribution — 20 distinct ids, print the variant spread per experiment.
console.log("\n(b) Spread — 20 distinct users across both experiments");
const spread = new Map<string, number>();
for (let i = 0; i < 20; i++) {
  const r = await post<DecideResponse>("/decide", { distinctId: `user_${i}` });
  for (const [key, value] of Object.entries(r.featureFlags)) {
    spread.set(`${key}=${String(value)}`, (spread.get(`${key}=${String(value)}`) ?? 0) + 1);
  }
}
for (const [bucket, n] of [...spread].sort()) {
  console.log(`     ${bucket.padEnd(28)} ${n}/20`);
}
// Both experiments must assign all 20 users (sum per experiment === 20).
const perExperiment = new Map<string, number>();
for (const [bucket, n] of spread) {
  const key = bucket.split("=")[0] ?? bucket;
  perExperiment.set(key, (perExperiment.get(key) ?? 0) + n);
}
ok("every user assigned in tu-billing-uk", perExperiment.get("tu-billing-uk") === 20);
ok("every user assigned in tu-reward-page", perExperiment.get("tu-reward-page") === 20);

// (c) Capture — a `paid` event returns PostHog's {status:1} ack.
console.log("\n(c) Capture — record a `paid` event");
const cap = await post<CaptureResponse>("/capture", {
  distinctId: id,
  event: "paid",
  properties: { amount: 19, currency: "GBP" },
});
ok(`POST /capture paid → status ${cap.status}`, cap.status === 1);

// (d) Flags — GET /flags lists both seeded experiments.
console.log("\n(d) Flags — list active experiments");
const flagsRes = await fetch(`${base}/flags`);
const flags = (await flagsRes.json()) as FlagsResponse;
const keys = flags.flags.map((f) => f.key).sort();
ok(
  `GET /flags → [${keys.join(", ")}]`,
  keys.length === 2 && keys[0] === "tu-billing-uk" && keys[1] === "tu-reward-page",
);

// Bonus: health probe.
const health = await fetch(`${base}/health`);
ok("GET /health → 200 {ok:true}", health.status === 200);

console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILED`}\n`);
server.close();
process.exit(failures === 0 ? 0 : 1);
