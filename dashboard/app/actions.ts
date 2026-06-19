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
import {
  deleteExperiment as storeDelete,
  experimentExists,
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

/** Create a new experiment. Key is the slug of the name unless provided. */
export async function createExperiment(input: ExperimentInput): Promise<ActionResult> {
  const error = validateInput(input);
  if (error) return { ok: false, error };

  const key = resolveKey(input);
  if (experimentExists(key)) {
    return {
      ok: false,
      error: `An experiment with key "${key}" already exists. Pick a different name or key.`,
    };
  }

  try {
    const created = insertExperiment(input);
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
  if (!experimentExists(key)) {
    return { ok: false, error: `No experiment with key "${key}".` };
  }
  // Validate with the locked key so slug-from-name can't silently change identity.
  const error = validateInput({ ...input, key });
  if (error) return { ok: false, error };

  try {
    storeUpdate(key, { ...input, key });
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
  const changed = storeSetActive(key, active);
  if (!changed) return { ok: false, error: `No experiment with key "${key}".` };
  revalidateFor(key);
  return { ok: true, key };
}

/** Delete an experiment (variants cascade). */
export async function deleteExperiment(key: string): Promise<ActionResult> {
  const removed = storeDelete(key);
  if (!removed) return { ok: false, error: `No experiment with key "${key}".` };
  revalidatePath("/");
  revalidatePath(`/experiments/${key}`);
  return { ok: true, key };
}
