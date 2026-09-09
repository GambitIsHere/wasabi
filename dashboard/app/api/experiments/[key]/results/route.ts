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
import { assignmentSplitForExperiment } from "@/lib/events";
import { srmCheck } from "@/lib/ab-stats";
import type { VariantRow } from "@/lib/verdict";

/** What the client needs to render the SRM early warning, or null when the
 *  check cannot run yet (no assignments stored, or fewer than two arms). */
export interface SrmPayload {
  available: true;
  arms: Array<{ variant: string; visitors: number; weight: number }>;
  totalVisitors: number;
  chiSquare: number;
  pValue: number;
  mismatch: boolean;
  window: {
    oldestTs: string | null;
    newestTs: string | null;
    retentionDays: number;
    capped: boolean;
  };
}

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
    // SRM rides alongside the verdict but is computed from a DIFFERENT source:
    // assignment events, not the payment P&L above. It is deliberately NOT
    // inside the cached block — the assignment read is a cheap local query, and
    // an early warning that is 45 seconds stale is worth less than a live one.
    //
    // It never fails the response. A missing table, an empty window or a
    // single-arm result yields srm: null and the panel says the check is not
    // available yet, because a broken early-warning must not take the results
    // page down with it.
    let srm: SrmPayload | null = null;
    try {
      const split = await assignmentSplitForExperiment(key);
      // Order the observed counts to match the experiment's declared arms, so
      // the expected split lines up arm-for-arm. An arm with no assignments yet
      // contributes a zero rather than being dropped, which is what makes a
      // never-assigned arm visible instead of silently excluded.
      const declared = experiment.flag.variants ?? [];
      const arms: Array<{ variant: string; visitors: number; weight: number }> =
        declared.map((v) => ({
          variant: v.key,
          visitors: split.counts.find((c) => c.variant === v.key)?.visitors ?? 0,
          weight: v.rolloutPercentage,
        }));
      const totalVisitors = arms.reduce((sum: number, a) => sum + a.visitors, 0);
      if (arms.length >= 2 && totalVisitors > 0) {
        const check = srmCheck(
          arms.map((a) => a.visitors),
          arms.map((a) => a.weight),
        );
        srm = {
          available: true,
          arms,
          totalVisitors,
          chiSquare: check.chiSquare,
          pValue: check.pValue,
          mismatch: check.mismatch,
          window: {
            oldestTs: split.oldestTs,
            newestTs: split.newestTs,
            retentionDays: split.retentionDays,
            capped: split.capped,
          },
        };
      }
    } catch {
      srm = null; // early warning unavailable; results still render
    }

    return NextResponse.json({ available: true, rows, verdict, metrics, srm });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Failed to build verdict";
    return NextResponse.json({ available: false, reason });
  }
}
