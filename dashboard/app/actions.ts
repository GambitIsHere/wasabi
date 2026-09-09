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
import {
  ARCHIVED_STATUSES,
  buildArchivedInputFromLive,
  buildRestoreInput,
  deleteArchived,
  getArchived,
  listArchived,
  upsertArchived,
  type ArchivedStatus,
  type LiveResultsSnapshot,
} from "@/lib/archive";
import { requireRole } from "@/lib/authz";
import { EMPTY_WIRING, experimentWiring, type ExperimentWiring } from "@/lib/events";
import type { ActionResult, BulkActionResult, ExperimentInput, StoredExperiment } from "@/lib/mgmt";
import { buildCloneInput, nextExpId, validateInput } from "@/lib/mgmt";
import { runResults } from "@/lib/metabase";
import { getMetrics } from "@/lib/metrics";
import {
  bulkDelete as storeBulkDelete,
  bulkSetActive as storeBulkSetActive,
  deleteExperiment as storeDelete,
  experimentExists,
  getExperiment,
  insertExperiment,
  listExperiments,
  resolveKey,
  setActive as storeSetActive,
  toRegistered,
  updateExperiment as storeUpdate,
} from "@/lib/store";
import { isUniqueViolation } from "@/lib/users";

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
  const gate = await requireRole("editor");
  if (!gate.ok) return { ok: false, error: gate.error };

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
    // experiment.key is a GLOBAL primary key across tenants (see
    // lib/tenant.ts's KNOWN LIMITATION note), so experimentExists() above only
    // rules out a SAME-tenant duplicate — it can't see another tenant's row.
    // If this key belongs to a DIFFERENT tenant, the INSERT above hits that
    // global constraint and Postgres throws a "duplicate key value violates
    // unique constraint" error naming the key. Returning that raw message
    // would confirm to this caller that some other tenant already owns the
    // key — genericise it instead. Any OTHER error (a real DB fault, a
    // network hiccup) still surfaces its real message below.
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: "That experiment key is already in use — pick another.",
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to create experiment.",
    };
  }
}

/**
 * Clone an existing experiment into a brand-new PAUSED one; returns the new key.
 * The copy gets a fresh EXP id (allocated from the same live+archived union the
 * new-test page uses, so the running counter stays global), a fresh key, its own
 * recomposed name, no YouTrack ticket, and a verbatim copy of the variants /
 * business / goal / description (see buildCloneInput). The caller sends the user
 * to the clone's edit page to review before it takes traffic.
 */
export async function cloneExperiment(sourceKey: string): Promise<ActionResult> {
  const gate = await requireRole("editor");
  if (!gate.ok) return { ok: false, error: gate.error };

  const source = await getExperiment(sourceKey);
  if (!source) return { ok: false, error: `No experiment with key "${sourceKey}".` };

  // Allocate the next free EXP id over every live + archived key AND name — the
  // same union app/experiments/new/page.tsx feeds the form, so the single running
  // counter never repeats or collides.
  const [live, archived] = await Promise.all([listExperiments(), listArchived()]);
  const seen = [
    ...live.flatMap((e) => [e.key, e.name]),
    ...archived.flatMap((a) => [a.key, a.name]),
  ];
  const input = buildCloneInput(source, nextExpId(seen));

  // Tolerate a source whose goal metric was de-registered since it was created,
  // exactly as updateExperiment does — cloning a still-valid experiment must not
  // fail on an orphaned goal metric.
  const error = validateInput(input, await allowedGoalMetrics(source.goalMetric));
  if (error) return { ok: false, error };

  const key = resolveKey(input);
  if (await experimentExists(key)) {
    return { ok: false, error: `An experiment with key "${key}" already exists. Try again.` };
  }

  try {
    const created = await insertExperiment(input);
    revalidateFor(created);
    return { ok: true, key: created };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, error: "That experiment key is already in use — pick another." };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to clone experiment.",
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
  const gate = await requireRole("editor");
  if (!gate.ok) return { ok: false, error: gate.error };

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
  const gate = await requireRole("editor");
  if (!gate.ok) return { ok: false, error: gate.error };

  const changed = await storeSetActive(key, active);
  if (!changed) return { ok: false, error: `No experiment with key "${key}".` };
  revalidateFor(key);
  return { ok: true, key };
}

/** Delete an experiment (variants cascade). */
export async function deleteExperiment(key: string): Promise<ActionResult> {
  const gate = await requireRole("editor");
  if (!gate.ok) return { ok: false, error: gate.error };

  const removed = await storeDelete(key);
  if (!removed) return { ok: false, error: `No experiment with key "${key}".` };
  revalidatePath("/");
  revalidatePath(`/experiments/${key}`);
  return { ok: true, key };
}

/**
 * Pause or activate several experiments at once. Thin wrapper over the store's
 * bulkSetActive: the editor gate runs once (a denied gate fails every key with
 * the gate error, so the caller can surface it), then the store tries each key
 * with per-key isolation. Revalidates the list only when a row actually changed.
 */
export async function bulkSetExperimentsActive(
  keys: string[],
  active: boolean,
): Promise<BulkActionResult> {
  const gate = await requireRole("editor");
  if (!gate.ok) return { changed: [], failed: keys.map((key) => ({ key, error: gate.error })) };

  const result = await storeBulkSetActive(keys, active);
  if (result.changed.length > 0) revalidatePath("/");
  return result;
}

/**
 * Delete several experiments at once (variants cascade). Same gate + partial-
 * failure contract as bulkSetExperimentsActive.
 */
export async function bulkDeleteExperiments(keys: string[]): Promise<BulkActionResult> {
  const gate = await requireRole("editor");
  if (!gate.ok) return { changed: [], failed: keys.map((key) => ({ key, error: gate.error })) };

  const result = await storeBulkDelete(keys);
  if (result.changed.length > 0) revalidatePath("/");
  return result;
}

// ---------------------------------------------------------------------------
// Complete → archive, and Restore → live. A completion FREEZES a live test's
// results into the archive then removes the live row; a restore is the inverse.
// Ordering is load-bearing: write the archive BEFORE deleting the live row, and
// insert the live row BEFORE deleting the archive — so a failure at any step
// leaves the run in exactly one place, never zero.
// ---------------------------------------------------------------------------

/** Today's date as YYYY-MM-DD (UTC) — the archived run's end date. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Gather a per-variant results snapshot for a live experiment. Two sources,
 * neither of which throws to the caller:
 *   - the LOCAL event store (experimentWiring) — always available, gives
 *     assignments (→ visitors) and goal captures (→ conversions) per arm;
 *   - Metabase (runResults) — the payment P&L, available only when configured
 *     (locally it returns { available:false }).
 * Wiring is laid down first as the fallback counts; runResults is overlaid on
 * top so its numbers win where present. Degrades to an empty snapshot when
 * neither source has data — the completion still archives (with 0/null figures)
 * rather than being blocked.
 *
 * runResults' typed VariantRow (lib/verdict.ts) exposes only a SINGLE aggregate
 * rebillRate — not the per-cycle R1/R2/R3 the raw SQL computes — so the rebill
 * read is carried on rebillR1 (the first-renewal cycle, which dominates at a
 * test's completion horizon) and R2/R3 are left null. netRevPerAcquired prefers
 * breakEvenCacGbp (net revenue ÷ acquired) and falls back to gross revPerAcquired.
 */
async function gatherLiveSnapshot(exp: StoredExperiment): Promise<LiveResultsSnapshot> {
  const byVariant: LiveResultsSnapshot["byVariant"] = {};

  let wiring: ExperimentWiring = EMPTY_WIRING;
  try {
    wiring = await experimentWiring(exp.key);
  } catch {
    wiring = EMPTY_WIRING;
  }
  for (const [variant, counts] of Object.entries(wiring.byArm)) {
    byVariant[variant] = {
      visitors: counts.assignmentsTotal,
      conversions: counts.capturesTotal,
    };
  }

  try {
    const outcome = await runResults(toRegistered(exp));
    if (outcome.available) {
      for (const row of outcome.rows) {
        byVariant[row.variant] = {
          ...byVariant[row.variant],
          visitors: row.appsAcquired,
          conversions: row.firstPaid,
          authRate: row.authRate,
          rebillR1: row.rebillRate,
          // Net revenue PER ACQUIRED customer: total net revenue (after refunds
          // / chargebacks) over acquired count. Falls back to gross rev-per-
          // acquired when the net figure isn't populated. NOT breakEvenCacGbp —
          // that's an acquisition-cost ceiling, a different number entirely.
          netRevPerAcquired:
            row.netRevenueGbp != null && row.appsAcquired > 0
              ? row.netRevenueGbp / row.appsAcquired
              : row.revPerAcquired,
        };
      }
    }
  } catch {
    // Keep the wiring-only snapshot — never let a Metabase hiccup block a completion.
  }

  return { byVariant };
}

/**
 * Complete a live experiment: snapshot its results, freeze them into the archive
 * with the chosen winner / verdict / note, then remove it from the live set.
 * The archive write happens FIRST — only if it succeeds is the live row deleted,
 * so a failed archive write never loses the experiment. Returns the ARCHIVED key.
 */
export async function completeExperiment(
  key: string,
  opts: { winnerVariant: string; status: ArchivedStatus; notes?: string },
): Promise<ActionResult> {
  const gate = await requireRole("editor");
  if (!gate.ok) return { ok: false, error: gate.error };

  const exp = await getExperiment(key);
  if (!exp) return { ok: false, error: `No experiment with key "${key}".` };

  if (!exp.variants.some((v) => v.key === opts.winnerVariant)) {
    return { ok: false, error: `Winner "${opts.winnerVariant}" is not one of this experiment's variants.` };
  }
  if (!(ARCHIVED_STATUSES as readonly string[]).includes(opts.status)) {
    return { ok: false, error: `Status must be one of: ${ARCHIVED_STATUSES.join(", ")}.` };
  }

  const snapshot = await gatherLiveSnapshot(exp);
  const input = buildArchivedInputFromLive(exp, snapshot, {
    winnerVariant: opts.winnerVariant,
    status: opts.status,
    notes: opts.notes,
    endDate: todayIso(),
  });

  // Archive FIRST. If this throws, the live row is untouched — no data loss.
  let archivedKey: string;
  try {
    archivedKey = await upsertArchived(input);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to archive the experiment.",
    };
  }

  // Only once the results are safely archived do we remove the live experiment.
  try {
    await storeDelete(key);
  } catch (err) {
    // The results are already in the archive; surface the failure without losing
    // them. Retrying is safe — upsertArchived is idempotent (delete + re-insert).
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Archived, but failed to remove the live experiment: ${err.message}`
          : "Archived, but failed to remove the live experiment.",
    };
  }

  revalidatePath("/");
  revalidatePath("/archive");
  revalidatePath(`/archive/${archivedKey}`);
  return { ok: true, key: archivedKey };
}

/**
 * Restore an archived run back to a live, PAUSED experiment (for review before
 * it takes traffic). The live insert happens FIRST — only if it succeeds is the
 * archived copy deleted, so a failed insert never loses the run. Guards against
 * clobbering a live experiment that already holds the key. Returns the live key.
 */
export async function restoreExperiment(key: string): Promise<ActionResult> {
  const gate = await requireRole("editor");
  if (!gate.ok) return { ok: false, error: gate.error };

  const archived = await getArchived(key);
  if (!archived) return { ok: false, error: `No archived experiment with key "${key}".` };

  const input = buildRestoreInput(archived);
  const newKey = resolveKey(input);
  if (await experimentExists(newKey)) {
    return {
      ok: false,
      error: `A live experiment with key "${newKey}" already exists. Rename or remove it before restoring.`,
    };
  }

  // Insert the live row FIRST. If this throws, the archived copy is untouched.
  let created: string;
  try {
    created = await insertExperiment(input);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, error: "That experiment key is already in use — pick another." };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to restore the experiment.",
    };
  }

  // Only once the live experiment exists do we drop the archived copy.
  try {
    await deleteArchived(key);
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Restored, but failed to remove the archived copy: ${err.message}`
          : "Restored, but failed to remove the archived copy.",
    };
  }

  revalidatePath("/archive");
  revalidateFor(created);
  return { ok: true, key: created };
}
