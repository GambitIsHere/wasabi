// Test helper: mutate the shared dev DB from a separate process so we can prove
// the RUNNING next-dev server reads the same store live. Commands:
//   CMD=create  → insert the dev-loop experiment
//   CMD=pause   → set it inactive
//   CMD=cleanup → delete it
import {
  insertExperiment,
  setActive,
  deleteExperiment,
} from "../lib/store.ts";
import type { ExperimentInput } from "../lib/mgmt.ts";

const KEY = "dev-loop-check";
const EXP: ExperimentInput = {
  name: "Dev Loop Check",
  key: KEY,
  business: "Global Visa",
  goalMetric: "conversion",
  startDate: "2026-06-15",
  variants: [
    { key: "control", rolloutPercentage: 50, themeSlug: "tu_lov_uk", isControl: true },
    { key: "treatment", rolloutPercentage: 50, themeSlug: "tu_lov_uk_19", isControl: false },
  ],
};

const cmd = process.env.CMD;
if (cmd === "create") {
  insertExperiment(EXP);
  console.log(`created ${KEY}`);
} else if (cmd === "pause") {
  console.log(`pause ${KEY}: ${setActive(KEY, false)}`);
} else if (cmd === "cleanup") {
  console.log(`cleanup ${KEY}: ${deleteExperiment(KEY)}`);
} else {
  throw new Error("Set CMD=create|pause|cleanup");
}
