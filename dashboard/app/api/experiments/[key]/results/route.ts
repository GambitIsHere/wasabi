// GET /api/experiments/[key]/results — run the live per-variant P&L query and
// build the verdict. Always returns 200 with a discriminated body:
//   { available: true,  rows, verdict }
//   { available: false, reason }
// The empty-state (no key, no data, query error) is a normal response, NOT a
// crash — so the UI is bug-free with or without METABASE_API_KEY.
import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getExperiment } from "@/lib/experiments";
import { runResults } from "@/lib/metabase";
import { buildVerdict } from "@/lib/verdict";
import { getMetrics } from "@/lib/metrics";
import { resultsCacheKeyParts } from "@/lib/results-cache";
import type { VariantRow } from "@/lib/verdict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Metabase P&L read is cached this long. Same window the home cockpit uses
// for the identical query (app/page.tsx's loadVerdictCached) — verdicts barely
// move minute to minute, so re-opening an experiment inside the window is near
// instant instead of paying a fresh round-trip to the shared payments DB.
const RESULTS_TTL_SECONDS = 45;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  const { key } = await params;
  const experiment = await getExperiment(key);
  if (!experiment) {
    return NextResponse.json(
      { available: false, reason: `Unknown experiment "${key}"` },
      { status: 404 },
    );
  }

  // Cache ONLY the expensive half — the live Metabase read — keyed so any
  // structural edit (a variant slug, the cohort start, a control reassignment,
  // a variant↔slug remap) busts it at once (resultsCacheKeyParts), while a plain
  // rename reuses it. Only the SUCCESS
  // path is cached: an unavailable outcome throws, so unstable_cache stores
  // nothing and a transient Metabase blip (or a timeout — see lib/metabase.ts)
  // self-heals on the next request rather than being pinned for the whole
  // window. The experiment itself is resolved OUTSIDE the cache above because
  // that read is tenant-scoped (cookies/headers), which unstable_cache forbids.
  let rows: VariantRow[];
  try {
    rows = await unstable_cache(
      async (): Promise<VariantRow[]> => {
        const outcome = await runResults(experiment);
        if (!outcome.available) throw new Error(outcome.reason);
        return outcome.rows;
      },
      resultsCacheKeyParts(experiment),
      { revalidate: RESULTS_TTL_SECONDS },
    )();
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown Metabase error";
    return NextResponse.json({ available: false, reason });
  }

  // buildVerdict can throw only if no control row is present; runResults already
  // guarantees one, but guard anyway so the route never 500s. Computed fresh off
  // the CURRENT metric registry every request (not cached with the rows above),
  // so a metric edit reflects immediately even on a results cache hit.
  try {
    const metrics = await getMetrics();
    const verdict = buildVerdict(rows, metrics);
    // `metrics` rides along so the client (components/LiveResults.tsx) can
    // render labels/units/decimals from the SAME registry snapshot the
    // verdict was computed against — never a second, possibly-stale fetch,
    // and never a hardcoded label map (see LiveResults.tsx's header).
    return NextResponse.json({ available: true, rows, verdict, metrics });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Failed to build verdict";
    return NextResponse.json({ available: false, reason });
  }
}
