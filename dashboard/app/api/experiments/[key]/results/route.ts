// GET /api/experiments/[key]/results — run the live per-variant P&L query and
// build the verdict. Always returns 200 with a discriminated body:
//   { available: true,  rows, verdict }
//   { available: false, reason }
// The empty-state (no key, no data, query error) is a normal response, NOT a
// crash — so the UI is bug-free with or without METABASE_API_KEY.
import { NextResponse } from "next/server";
import { getExperiment } from "@/lib/experiments";
import { runResults } from "@/lib/metabase";
import { buildVerdict, type VariantRow } from "@/lib/verdict";
import { getMetrics } from "@/lib/metrics";
import { purchaseCountsByVariant } from "@/lib/events";
import { mergePurchaseCounts, buildEventOnlyRows } from "@/lib/purchase-results";

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

  // Captured purchases from the local `event` table — the data plane behind the
  // `purchases` goal metric (lib/seeds.ts), which Metabase's payments query does
  // not carry. Read defensively: a DB hiccup (or no DATABASE_URL locally) must
  // degrade to "no purchases" rather than fail the whole results response —
  // same posture as the detail page's experimentWiring() guard.
  let purchaseCounts: Record<string, number> = {};
  try {
    purchaseCounts = await purchaseCountsByVariant(key);
  } catch {
    purchaseCounts = {};
  }

  const outcome = await runResults(experiment);

  // Two paths to a row set (see lib/purchase-results.ts):
  //   - Metabase HAS cohort rows → graft the purchase counts onto them.
  //   - Metabase has none (a split-URL test like GP-603 whose arms aren't real
  //     global-api themes) → if the arm is still capturing purchases, build
  //     event-only rows so the purchase goal renders; otherwise pass the empty
  //     state through unchanged (the "Connect Metabase" reason).
  let rows: VariantRow[];
  if (outcome.available) {
    rows = mergePurchaseCounts(outcome.rows, purchaseCounts);
  } else {
    const eventRows = buildEventOnlyRows(experiment, purchaseCounts);
    if (eventRows.length > 0 && eventRows.some((r) => r.isControl)) {
      rows = eventRows;
    } else {
      return NextResponse.json({ available: false, reason: outcome.reason });
    }
  }

  // buildVerdict can throw only if no control row is present; both paths above
  // guarantee one, but guard anyway so the route never 500s.
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
