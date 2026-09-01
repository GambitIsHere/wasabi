// GET /api/experiments/[key]/results — run the live per-variant P&L query and
// build the verdict. Always returns 200 with a discriminated body:
//   { available: true,  rows, verdict }
//   { available: false, reason }
// The empty-state (no key, no data, query error) is a normal response, NOT a
// crash — so the UI is bug-free with or without METABASE_API_KEY.
import { NextResponse } from "next/server";
import { getExperiment } from "@/lib/experiments";
import { runResults } from "@/lib/metabase";
import { buildVerdict } from "@/lib/verdict";
import { getMetrics } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const outcome = await runResults(experiment);
  if (!outcome.available) {
    return NextResponse.json({ available: false, reason: outcome.reason });
  }

  // buildVerdict can throw only if no control row is present; runResults already
  // guarantees one, but guard anyway so the route never 500s.
  try {
    const metrics = await getMetrics();
    const verdict = buildVerdict(outcome.rows, metrics);
    // `metrics` rides along so the client (components/LiveResults.tsx) can
    // render labels/units/decimals from the SAME registry snapshot the
    // verdict was computed against — never a second, possibly-stale fetch,
    // and never a hardcoded label map (see LiveResults.tsx's header).
    return NextResponse.json({ available: true, rows: outcome.rows, verdict, metrics });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Failed to build verdict";
    return NextResponse.json({ available: false, reason });
  }
}
