// PATCH /api/admin/metrics/[key] — update a metric (including enable/disable:
//   that's just this same PATCH with `enabled` toggled, not a separate route).
// DELETE /api/admin/metrics/[key] — remove a metric permanently.
//
// The URL's `key` is the authoritative identity for BOTH verbs — a `key` in
// the PATCH body, if present, is ignored (mirrors lib/metrics.ts's
// updateMetric, which does the same: the key is immutable once created).
//
// Auth is enforced by the global NextAuth middleware (this path is NOT in
// PUBLIC_PREFIXES — see middleware.ts). Fail-closed: a bad body or a
// business-rule violation is a 400 with a reason, an unknown key is a 404,
// never a 500 for either.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/authz";
import { deleteMetric, updateMetric } from "@/lib/metrics";
import { validateMetricDef } from "@/lib/metrics-core";
import { parseMetricInput } from "../parse-input";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  const gate = await requireRole("admin");
  if (!gate.ok) {
    return NextResponse.json({ ok: false, reason: gate.error }, { status: gate.status });
  }

  const { key } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "Body is not valid JSON." }, { status: 400 });
  }

  // The body's own `key` (if any) is irrelevant — parseMetricInput requires
  // SOME key to build a well-typed MetricInput, but the URL's key always wins
  // for identity, so accept either shape without forcing the client to repeat
  // the key inside the JSON body too.
  const withKey =
    raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>), key } : raw;
  const parsed = parseMetricInput(withKey);
  if (typeof parsed === "string") {
    return NextResponse.json({ ok: false, reason: parsed }, { status: 400 });
  }

  const validationError = validateMetricDef(parsed);
  if (validationError) {
    return NextResponse.json({ ok: false, reason: validationError }, { status: 400 });
  }

  try {
    await updateMetric(key, parsed);
    return NextResponse.json({ ok: true, key });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "Failed to update metric." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  const gate = await requireRole("admin");
  if (!gate.ok) {
    return NextResponse.json({ ok: false, reason: gate.error }, { status: gate.status });
  }

  const { key } = await params;
  try {
    const removed = await deleteMetric(key);
    if (!removed) {
      return NextResponse.json({ ok: false, reason: `No metric with key "${key}".` }, { status: 404 });
    }
    return NextResponse.json({ ok: true, key });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "Failed to delete metric." },
      { status: 500 },
    );
  }
}
