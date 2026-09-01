// POST /api/admin/reseed — DESTRUCTIVE: wipe + re-apply the canonical SEED.
//
// Authentication is enforced by the global NextAuth middleware (this path is NOT
// in PUBLIC_PREFIXES). AUTHORIZATION is enforced here: this is the single most
// destructive verb in the app (it wipes the tenant's experiments/variants), so
// it requires the top role — `owner`. requireRole re-derives the role from the
// membership table, never the JWT.
import { NextResponse } from "next/server";
import { applySeed } from "@/lib/admin-reseed";
import { requireRole } from "@/lib/authz";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const gate = await requireRole("owner");
  if (!gate.ok) {
    return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });
  }

  try {
    const result = await applySeed();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/admin/reseed] failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
