// ============================================================================
// Wasabi — cache key for an experiment's live Metabase P&L read (pure).
// ----------------------------------------------------------------------------
// The per-variant results query (lib/metabase.ts runResults) is the single most
// expensive thing the experiment-detail path does: a native query against the
// SHARED live payments DB. app/api/experiments/[key]/results used to re-run it
// on EVERY open, uncached, so opening the same experiment twice paid the full
// Metabase round-trip twice. Caching it needs a key that busts the moment the
// query's INPUTS change but is otherwise stable — that key is built here, kept
// pure (no DB, no Next imports) so it can be unit-tested directly.
//
// The query reads only WHICH cohort to pull: the theme slugs and the cohort
// start date. So those two are the whole key. A rename / description edit (which
// the query never reads) correctly reuses the cache; a slug or start-date edit
// busts it immediately. Slugs are sorted so reordering variants alone never
// churns the key. This mirrors the staleness tradeoff app/page.tsx's cockpit
// already makes for the same query (loadVerdictCached, 45s) — only the advancing
// "now" end of the cohort window can be briefly stale within the TTL.
// ============================================================================
import type { RegisteredExperiment } from "./experiments";

/** Stable, input-derived cache-key parts for an experiment's Metabase P&L read. */
export function resultsCacheKeyParts(experiment: RegisteredExperiment): string[] {
  const slugs = experiment.resultsThemeMap
    .map((r) => r.themeSlug)
    .filter((s) => s.length > 0)
    .sort();
  return [
    "experiment-results",
    experiment.flag.key,
    experiment.startDate,
    slugs.join(","),
  ];
}
