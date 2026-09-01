// POST /api/admin/metrics — create a new metric registry row.
//
// Body: a MetricInput (see parse-input.ts's parseMetricInput for the exact
// shape). Listing is NOT an API route here — app/admin/metrics/page.tsx reads
// listMetricsUncached() directly (it's a server component), so there's no
// client-side GET to keep in sync; the admin page calls router.refresh()
// after a successful write, same pattern as ReseedButton/ImportVwoForm.
//
// Auth is enforced by the global NextAuth middleware (this path is NOT in
// PUBLIC_PREFIXES — see middleware.ts). Fail-closed: a bad body or a business-
// rule violation is a 400 with a reason, never a 500 — a validation problem
// must never look like a server crash.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createMetric } from "@/lib/metrics";
import { validateMetricDef } from "@/lib/metrics-core";
import { parseMetricInput } from "./parse-input";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "Body is not valid JSON." }, { status: 400 });
  }

  const parsed = parseMetricInput(raw);
  if (typeof parsed === "string") {
    return NextResponse.json({ ok: false, reason: parsed }, { status: 400 });
  }

  // Validate here (not just inside createMetric) so a business-rule violation
  // is unambiguously a 400 — createMetric re-validates too (it's the
  // authoritative, DB-adjacent gate) but by the time IT throws we can no
  // longer tell "bad input" apart from a genuine DB fault without fragile
  // string-matching on the error message.
  const validationError = validateMetricDef(parsed);
  if (validationError) {
    return NextResponse.json({ ok: false, reason: validationError }, { status: 400 });
  }

  try {
    const key = await createMetric(parsed);
    return NextResponse.json({ ok: true, key });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create metric.";
    // The DB's PRIMARY KEY constraint is the backstop for key uniqueness (see
    // createMetric's doc comment) — surface that specific case as a
    // caller-fixable 400 rather than a 500.
    const isDuplicateKey = /duplicate key|already exists/i.test(message);
    return NextResponse.json(
      { ok: false, reason: isDuplicateKey ? `A metric with key "${parsed.key}" already exists.` : message },
      { status: isDuplicateKey ? 400 : 500 },
    );
  }
}
