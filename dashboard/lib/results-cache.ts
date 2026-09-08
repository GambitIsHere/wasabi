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
// The Metabase QUERY reads only WHICH cohort to pull: the theme slugs and the
// cohort start date. But the VALUE we cache is the per-variant rows, and each
// row's `variant` label and `isControl` flag are stamped from the variant→slug
// mapping and controlVariant (lib/metabase.ts runResults) — inputs the raw query
// never touches. So the key carries all of them: flag key, start date,
// controlVariant, and the sorted `variant:themeSlug` pairs. A rename or
// description edit (which nothing in the cached value reads) correctly reuses the
// cache; a slug edit, a start-date edit, a control reassignment, or a
// variant↔slug remap each busts it immediately. Pairs are sorted so reordering
// variants alone never churns the key. This mirrors the staleness tradeoff
// app/page.tsx's cockpit already makes for the same query (loadVerdictCached,
// 45s) — only the advancing "now" end of the cohort window can be briefly stale
// within the TTL.
// ============================================================================
import type { RegisteredExperiment } from "./experiments";

/** Stable, input-derived cache-key parts for an experiment's Metabase P&L read. */
export function resultsCacheKeyParts(experiment: RegisteredExperiment): string[] {
  // `variant:themeSlug` pairs, empty slugs dropped, sorted. The variant name
  // rides with its slug so a remap (same slug set, different labels) still busts;
  // sorting keeps a pure variant reorder from churning the key.
  const pairs = experiment.resultsThemeMap
    .filter((r) => r.themeSlug.length > 0)
    .map((r) => `${r.variant}:${r.themeSlug}`)
    .sort();
  return [
    "experiment-results",
    experiment.flag.key,
    experiment.startDate,
    experiment.controlVariant,
    pairs.join(","),
  ];
}
