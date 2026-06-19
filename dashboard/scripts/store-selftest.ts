// ============================================================================
// Store self-test — proves the SQLite-backed store persists across a full
// experiment lifecycle: create → list → get → toggle active → delete, plus a
// reopen to prove the data is read back from disk (true persistence).
//
// Zero deps. Run with:
//   WASABI_DB=/tmp/wasabi-selftest.db node \
//     --experimental-strip-types --no-warnings \
//     --import ./scripts/ts-resolve-hook-register.mjs scripts/store-selftest.ts
// ============================================================================
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  insertExperiment,
  listExperiments,
  getExperiment,
  experimentExists,
  setActive,
  deleteExperiment,
} from "../lib/store.ts";
import type { ExperimentInput } from "../lib/mgmt.ts";

const dbPath = process.env.WASABI_DB;
assert.ok(dbPath, "WASABI_DB must point at a temp DB file");

let pass = 0;
function ok(label: string) {
  pass += 1;
  console.log(`  ✓ ${label}`);
}

const NEW: ExperimentInput = {
  name: "Self Test Experiment",
  key: "self-test-experiment",
  business: "PDF SaaS",
  goalMetric: "conversion",
  startDate: "2026-06-01",
  variants: [
    { key: "control", rolloutPercentage: 60, themeSlug: "tu_lov_uk", isControl: true },
    { key: "challenger", rolloutPercentage: 40, themeSlug: "tu_lov_uk_19", isControl: false },
  ],
};

console.log("Store self-test (SQLite persistence)");
console.log(`  DB: ${dbPath}`);

// --- seed-on-empty fires via listExperiments() ---
const seeded = listExperiments();
assert.equal(seeded.length, 2, "two seed experiments on an empty DB");
assert.ok(seeded.some((e) => e.key === "tu-billing-uk"), "tu-billing-uk seeded");
assert.ok(seeded.some((e) => e.key === "tu-reward-page"), "tu-reward-page seeded");
ok("seed-once created the 2 example experiments");

// --- create ---
const key = insertExperiment(NEW);
assert.equal(key, "self-test-experiment");
assert.ok(experimentExists(key), "experimentExists true after insert");
ok("createExperiment persisted a new row");

// --- list includes it ---
const afterCreate = listExperiments();
assert.equal(afterCreate.length, 3, "list now has 3");
ok("listExperiments returns the new experiment");

// --- get returns the full shape ---
const got = getExperiment(key);
assert.ok(got, "getExperiment returns a row");
assert.equal(got.name, "Self Test Experiment");
assert.equal(got.business, "PDF SaaS");
assert.equal(got.goalMetric, "conversion");
assert.equal(got.active, true, "new experiments default active");
assert.equal(got.variants.length, 2);
assert.equal(got.controlVariant, "control");
assert.equal(got.rolloutPercentage, 100);
assert.deepEqual(got.themeMap, { control: "tu_lov_uk", challenger: "tu_lov_uk_19" });
const total = got.variants.reduce((s, v) => s + v.rolloutPercentage, 0);
assert.equal(total, 100, "splits sum to 100");
assert.equal(got.variants.filter((v) => v.isControl).length, 1, "exactly one control");
ok("getExperiment returns the persisted shape (variants, control, themeMap)");

// --- toggle active ---
assert.equal(setActive(key, false), true, "setActive(false) affected a row");
assert.equal(getExperiment(key)?.active, false, "now paused");
assert.equal(setActive(key, true), true);
assert.equal(getExperiment(key)?.active, true, "active again");
ok("setActive toggles persisted state");

// --- delete (cascades variants) ---
assert.equal(deleteExperiment(key), true, "delete affected a row");
assert.equal(getExperiment(key), undefined, "gone after delete");
assert.equal(experimentExists(key), false);
assert.equal(listExperiments().length, 2, "back to the 2 seeds");
ok("deleteExperiment removes the row (and cascades variants)");

assert.ok(existsSync(dbPath), "DB file exists on disk");
console.log(`\n${pass} checks passed. DB file written to disk: ${existsSync(dbPath)}`);
