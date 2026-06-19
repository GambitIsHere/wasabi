// ============================================================================
// Persistence proof — run in TWO separate processes against the SAME WASABI_DB:
//   PHASE=write  → insert a row, then exit (connection closes with the process).
//   PHASE=read   → open a fresh connection and assert the row is read back.
// Proves the store survives a full process restart (true on-disk persistence).
// ============================================================================
import assert from "node:assert/strict";
import {
  insertExperiment,
  getExperiment,
  deleteExperiment,
} from "../lib/store.ts";
import type { ExperimentInput } from "../lib/mgmt.ts";

const phase = process.env.PHASE;
const KEY = "persist-check";

const ROW: ExperimentInput = {
  name: "Persist Check",
  key: KEY,
  business: "Gift Cards",
  goalMetric: "auth_rate",
  startDate: "2026-06-10",
  variants: [
    { key: "control", rolloutPercentage: 70, themeSlug: "tu_lov_uk", isControl: true },
    { key: "v2", rolloutPercentage: 30, themeSlug: "tu_lov_ie_serenity", isControl: false },
  ],
};

if (phase === "write") {
  insertExperiment(ROW);
  console.log(`  [write] inserted "${KEY}" then exiting (process/connection ends)`);
} else if (phase === "read") {
  const got = getExperiment(KEY);
  assert.ok(got, "row read back from disk in a FRESH process");
  assert.equal(got.name, "Persist Check");
  assert.equal(got.business, "Gift Cards");
  assert.equal(got.goalMetric, "auth_rate");
  assert.equal(got.variants.length, 2);
  assert.equal(got.controlVariant, "control");
  assert.deepEqual(got.themeMap, { control: "tu_lov_uk", v2: "tu_lov_ie_serenity" });
  deleteExperiment(KEY); // cleanup
  console.log(`  [read] ✓ "${KEY}" survived the process restart and was read back from disk`);
} else {
  throw new Error("Set PHASE=write or PHASE=read");
}
