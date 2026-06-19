// ============================================================================
// Experiment registry — engine-facing view over the DB-backed store.
// ----------------------------------------------------------------------------
// Was a static array; now a thin adapter over lib/store.ts (SQLite). Keeps the
// SAME public surface the engine and pages already import — getExperiments,
// getExperimentFlags, getExperiment, getThemeMap — so lib/engine/handlers.ts,
// lib/metabase.ts, and the API routes need zero changes.
//
// The RegisteredExperiment interface stays here as the engine's contract; the
// store builds it from StoredExperiment via toRegistered().
//
// SERVER-ONLY (transitively imports node:sqlite via the store). Only imported
// from server components and route handlers, never a client component.
import type { FeatureFlag, ThemeMap } from "./engine/types";
import { listExperiments, getExperiment as storeGet, toRegistered } from "./store";

/**
 * One registered experiment in the engine's shape: the assignable flag, its
 * theme mapping (the storefront `?theme=` contract), plus results metadata.
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
export function getExperiments(): RegisteredExperiment[] {
  return listExperiments().map(toRegistered);
}

/** All experiment flags (creation order) — for the engine handlers (/decide, /flags). */
export function getExperimentFlags(): FeatureFlag[] {
  return listExperiments().map((e) => toRegistered(e).flag);
}

/** A single registered experiment by key, or undefined if not registered. */
export function getExperiment(key: string): RegisteredExperiment | undefined {
  const stored = storeGet(key);
  return stored ? toRegistered(stored) : undefined;
}

/** A single experiment's live variant → theme-slug map by key, or undefined. */
export function getThemeMap(key: string): ThemeMap | undefined {
  return storeGet(key)?.themeMap;
}
