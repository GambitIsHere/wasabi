// POST /api/admin/insight — set the free-text insight on an archived experiment.
//
// The insight is the one-line read a human writes after the analytics audit
// ("variant held R2 retention; ship it"). It cannot go through the VWO import
// path — that upsert cascade-deletes the variants and would wipe any attached
// payment metrics — so this is the non-destructive in-place setter.
//
// Body: { key: string, insight: string }   (insight "" clears it)
// Authentication is enforced by the global NextAuth middleware (not in
// PUBLIC_PREFIXES). AUTHORIZATION — at least `admin` — is enforced here: it
// rewrites stored analysis on the tenant's archived experiments.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { setArchivedInsight } from "@/lib/archive";
import { requireRole } from "@/lib/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await requireRole("admin");
  if (!gate.ok) {
    return NextResponse.json({ ok: false, reason: gate.error }, { status: gate.status });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Body is not valid JSON." },
      { status: 400 },
    );
  }

  if (!raw || typeof raw !== "object") {
    return NextResponse.json(
      { ok: false, reason: "Expected { key: string, insight: string }." },
      { status: 400 },
    );
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.key !== "string" || b.key.trim().length === 0) {
    return NextResponse.json(
      { ok: false, reason: "key is required." },
      { status: 400 },
    );
  }
  if (typeof b.insight !== "string") {
    return NextResponse.json(
      { ok: false, reason: "insight must be a string." },
      { status: 400 },
    );
  }

  const found = await setArchivedInsight(b.key.trim(), b.insight);
  if (!found) {
    return NextResponse.json(
      { ok: false, reason: `Unknown archived experiment "${b.key.trim()}"` },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, key: b.key.trim() });
}
