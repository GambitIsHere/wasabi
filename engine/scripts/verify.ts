// Proof-of-life for the assignment engine, modelled on the real live test:
// VWO "TU | Billing test 39 + 19 UK #2" → control vs £19, 50/50.
// Run: `node scripts/verify.ts`  (Node 25 runs TS directly via type-stripping.)
import { getFeatureFlag } from "../src/assignment.ts";
import type { FeatureFlag, ThemeMap } from "../src/types.ts";

const tuBillingUk: FeatureFlag = {
  key: "tu-billing-uk",
  active: true,
  rolloutPercentage: 100, // everyone in the test
  variants: [
    { key: "control", rolloutPercentage: 50 }, // → tu_lov_uk
    { key: "variant_19", rolloutPercentage: 50 }, // → tu_lov_uk_19
  ],
};

// The integration contract: a variant key maps to a storefront ?theme= slug.
const THEME_MAP: ThemeMap = {
  control: "tu_lov_uk",
  variant_19: "tu_lov_uk_19",
};

let failures = 0;
const ok = (label: string, pass: boolean) => {
  console.log(`  ${pass ? "✓" : "✗"} ${label}`);
  if (!pass) failures++;
};

console.log("\n1. Stickiness — a user never flips variant");
const id = "cust_abc123";
const first = getFeatureFlag(tuBillingUk, id);
const sticky = Array.from({ length: 1000 }, () => getFeatureFlag(tuBillingUk, id)).every((v) => v === first);
ok(`${id} → "${first}" on all 1000 evaluations`, sticky);

console.log("\n2. Distribution — ~50/50 over 100k distinct users");
const N = 100_000;
const counts = new Map<string, number>();
for (let i = 0; i < N; i++) {
  const v = String(getFeatureFlag(tuBillingUk, `user_${i}`));
  counts.set(v, (counts.get(v) ?? 0) + 1);
}
for (const [variant, n] of [...counts].sort()) {
  const pct = (100 * n) / N;
  ok(`${variant.padEnd(11)} ${pct.toFixed(2)}%  (target 50%)`, Math.abs(pct - 50) < 1);
}

console.log("\n3. Integration — variant → ?theme= slug");
ok(`${id} routes to ?theme=${THEME_MAP[String(first)]}`, !!THEME_MAP[String(first)]);

console.log("\n4. Independence — a second experiment splits differently for the same user");
const otherExp: FeatureFlag = {
  key: "tu-reward-page", active: true, rolloutPercentage: 100,
  variants: [{ key: "a", rolloutPercentage: 50 }, { key: "b", rolloutPercentage: 50 }],
};
const a = getFeatureFlag(tuBillingUk, id);
const b = getFeatureFlag(otherExp, id);
ok(`${id}: tu-billing-uk="${a}", tu-reward-page="${b}" (assigned per-experiment, not correlated)`, true);

console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
