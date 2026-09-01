"use server";

// ============================================================================
// Wasabi — experiment management server actions.
// ----------------------------------------------------------------------------
// The write path for the management UI. Each action:
//   1. validates the input against the SAME rules the form uses (lib/mgmt.ts),
//   2. enforces DB-level invariants (key uniqueness on create, key immutability
//      on edit),
//   3. persists via the server-only store (lib/store.ts → SQLite),
//   4. revalidates the affected paths so server components re-read fresh data.
//
// All return ActionResult — never throw across the server boundary, so the
// client form can render a clean inline error.
// ============================================================================
import { revalidatePath } from "next/cache";
import type { ActionResult, ExperimentInput } from "@/lib/mgmt";
import { validateInput } from "@/lib/mgmt";
import { getMetrics } from "@/lib/metrics";
import {
  deleteExperiment as storeDelete,
  experimentExists,
  getExperiment,
  insertExperiment,
  resolveKey,
  setActive as storeSetActive,
  updateExperiment as storeUpdate,
} from "@/lib/store";

/** Re-read the list + a specific detail/edit route after a write. */
function revalidateFor(key: string): void {
  revalidatePath("/");
  revalidatePath(`/experiments/${key}`);
  revalidatePath(`/experiments/${key}/edit`);
}

/**
 * The goal-metric keys validateInput is allowed to accept: every registry
 * metric flagged isGoal, PLUS (when editing) the experiment's OWN current
 * goalMetric even if it's not — or no longer — a registry goal metric. That
 * union is what makes "existing experiments keep working" real rather than
 * aspirational: an experiment created before a metric was renamed/removed
 * from the registry can still be saved (unrelated edits aren't blocked by an
 * orphaned goal metric) without silently rewriting its stored value, and a
 * genuinely NEW goal-metric selection still has to be a real registry metric.
 * A DB read — this is exactly why lib/mgmt.ts can't compute this list itself.
 */
async function allowedGoalMetrics(currentGoalMetric?: string): Promise<string[]> {
  const metrics = await getMetrics();
  const keys = metrics.filter((m) => m.isGoal).map((m) => m.key);
  if (currentGoalMetric && !keys.includes(currentGoalMetric)) keys.push(currentGoalMetric);
  return keys;
}

/** Create a new experiment. Key is the slug of the name unless provided. */
export async function createExperiment(input: ExperimentInput): Promise<ActionResult> {
  const error = validateInput(input, await allowedGoalMetrics());
  if (error) return { ok: false, error };

  const key = resolveKey(input);
  if (await experimentExists(key)) {
    return {
      ok: false,
      error: `An experiment with key "${key}" already exists. Pick a different name or key.`,
    };
  }

  try {
    const created = await insertExperiment(input);
    revalidateFor(created);
    return { ok: true, key: created };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to create experiment.",
    };
  }
}

/**
 * Update an existing experiment. The key is IMMUTABLE — `key` identifies the
 * row; any key on `input` is ignored for identity. 404s if the key is unknown.
 */
export async function updateExperiment(
  key: string,
  input: ExperimentInput,
): Promise<ActionResult> {
  const existing = await getExperiment(key);
  if (!existing) {
    return { ok: false, error: `No experiment with key "${key}".` };
  }
  // Validate with the locked key so slug-from-name can't silently change
  // identity, and with the existing goalMetric unioned in (see
  // allowedGoalMetrics) so an orphaned legacy value doesn't block the save.
  const error = validateInput({ ...input, key }, await allowedGoalMetrics(existing.goalMetric));
  if (error) return { ok: false, error };

  try {
    await storeUpdate(key, { ...input, key });
    revalidateFor(key);
    return { ok: true, key };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to update experiment.",
    };
  }
}

/** Activate or pause an experiment. */
export async function setExperimentActive(
  key: string,
  active: boolean,
): Promise<ActionResult> {
  const changed = await storeSetActive(key, active);
  if (!changed) return { ok: false, error: `No experiment with key "${key}".` };
  revalidateFor(key);
  return { ok: true, key };
}

/** Delete an experiment (variants cascade). */
export async function deleteExperiment(key: string): Promise<ActionResult> {
  const removed = await storeDelete(key);
  if (!removed) return { ok: false, error: `No experiment with key "${key}".` };
  revalidatePath("/");
  revalidatePath(`/experiments/${key}`);
  return { ok: true, key };
}
