// GET /api/tickets — the experiment backlog sourced from YouTrack (read-only).
//
// Returns the testing tickets Wasabi knows about, deduped + de-noised, each
// tagged with its Wasabi business. Behind the admin middleware (it is NOT on
// the public /api/decide+/api/capture allowlist), so ticket context stays
// internal. Degrades to { configured: false, tickets: [] } when no token is set.
//
//   ?open=false   include resolved tickets (the test history), not just the backlog
//   ?refresh=true bypass the 60s cache
import { NextRequest, NextResponse } from "next/server";
import { getExperimentBacklog } from "@/lib/backlog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const open = req.nextUrl.searchParams.get("open") !== "false";
  const refresh = req.nextUrl.searchParams.get("refresh") === "true";
  try {
    const backlog = await getExperimentBacklog({ open, refresh });
    return NextResponse.json(backlog);
  } catch (err) {
    return NextResponse.json(
      { configured: true, error: err instanceof Error ? err.message : "YouTrack lookup failed", tickets: [] },
      { status: 502 },
    );
  }
}
