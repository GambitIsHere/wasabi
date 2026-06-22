// GET /api/experiments — full experiment definitions (read-only).
//
// Unlike /api/flags (PostHog wire shape: keys + active only), this returns the
// complete admin view — every variant with its rollout %, theme slug, and
// control flag — straight from the live SQLite store. It's what the `wasabi`
// CLI and any external tooling read so they reflect exactly what the admin UI
// shows, instead of a divergent fixture. Read-only: no mutation surface here.
import { NextResponse } from "next/server";
import { listExperiments } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ experiments: await listExperiments() });
}
