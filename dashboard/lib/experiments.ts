// ============================================================================
// Experiment registry — engine-facing view over the DB-backed store.
// ----------------------------------------------------------------------------
// Was a static array; now a thin adapter over lib/store.ts (Neon Postgres). Keeps
// the SAME public surface the engine and pages import — getExperiments,
// getExperimentFlags, getExperiment, getThemeMap — but every function is now async
// (the store is serverless Postgres over HTTP).
//
// The RegisteredExperiment interface stays here as the engine's contract; the
// store builds it from StoredExperiment via toRegistered().
//
// SERVER-ONLY (transitively imports the Postgres store). Only imported from server
// components and route handlers, never a client component.
import type { FeatureFlag, ThemeMap } from "./engine/types";
import { listExperiments, getExperiment as storeGet, toRegistered } from "./store";

/**
 * One registered experiment in the engine's shape: the assignable flag, its theme
 * mapping (the storefront `?theme=` contract), plus results metadata.
 */
export interface RegisteredExperiment {
  /** The assignable flag (key, active, rollout, live variant split). */
  flag: FeatureFlag;
  /** Human-readable name for the dashboard. */
  name: string;
  /** One-line description of what the experiment tests. */
  description: string;
  /** Live variant key → storefront `?theme=` slug (assignment contract). */
  themeMap: ThemeMap;
  /** The control variant key — the baseline everything is measured against. */
  controlVariant: string;
  /** ISO date (YYYY-MM-DD) the experiment cohort starts (Application.createdAt floor). */
  startDate: string;
  /**
   * Variant key → theme slug for the RESULTS query. For managed experiments this
   * mirrors the live split (no retired/historical arms are tracked). Order kept.
   */
  resultsThemeMap: Array<{ variant: string; themeSlug: string }>;
}

/** All registered experiments (seed/creation order) — for the dashboard list and /flags. */
export async function getExperiments(): Promise<RegisteredExperiment[]> {
  return (await listExperiments()).map(toRegistered);
}

/** All experiment flags (creation order) — for the engine handlers (/decide, /flags). */
export async function getExperimentFlags(): Promise<FeatureFlag[]> {
  return (await listExperiments()).map((e) => toRegistered(e).flag);
}

/** A single registered experiment by key, or undefined if not registered. */
export async function getExperiment(
  key: string,
): Promise<RegisteredExperiment | undefined> {
  const stored = await storeGet(key);
  return stored ? toRegistered(stored) : undefined;
}

/** A single experiment's live variant → theme-slug map by key, or undefined. */
export async function getThemeMap(key: string): Promise<ThemeMap | undefined> {
  return (await storeGet(key))?.themeMap;
}
