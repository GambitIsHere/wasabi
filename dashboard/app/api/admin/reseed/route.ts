// POST /api/admin/reseed — DESTRUCTIVE: wipe + re-apply the canonical SEED.
//
// Auth is enforced by the global NextAuth middleware (this path is NOT in
// PUBLIC_PREFIXES, so unauthenticated requests get redirected to /signin
// before this handler runs).
import { NextResponse } from "next/server";
import { applySeed } from "@/lib/admin-reseed";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  try {
    const result = await applySeed();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/admin/reseed] failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
