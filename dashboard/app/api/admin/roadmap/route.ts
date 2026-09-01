// POST /api/admin/roadmap — persist one drag on the roadmap runway.
//
// The drag-and-drop runway (components/roadmap/EditableRunway.tsx) calls this
// after a tile is dropped: it moves the tile to a new lane, re-times it to a new
// week window (keeping its duration), and re-orders it within the lane. This
// writes those four fields for one row via the roadmap store.
//
// Body: { id, lane, startWeek, endWeek, position }
//
// Authentication is enforced by the global NextAuth middleware (this path is NOT
// in PUBLIC_PREFIXES). AUTHORIZATION — at least `admin` — is enforced here: it
// persists edits to the tenant's shared roadmap. Fail-closed: a bad body is a
// 400 with a reason, never a 500 — a validation problem must never look like a
// server crash.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/authz";
import { LANES, type Lane } from "@/lib/roadmap";
import {
  updateRoadmapTest,
  RoadmapValidationError,
} from "@/lib/roadmap-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RoadmapBody {
  id: string;
  lane: Lane;
  startWeek: number;
  endWeek: number;
  position: number;
}

const LANE_SET = new Set<Lane>(LANES);

/** Validate + narrow the request body. Returns a reason string on any violation. */
function parseBody(body: unknown): RoadmapBody | string {
  if (!body || typeof body !== "object") return "Body must be a JSON object.";
  const b = body as Record<string, unknown>;

  if (typeof b.id !== "string" || b.id.trim().length === 0) {
    return "id is required.";
  }
  if (typeof b.lane !== "string" || !LANE_SET.has(b.lane as Lane)) {
    return `lane must be one of ${LANES.join(", ")}.`;
  }
  for (const field of ["startWeek", "endWeek", "position"] as const) {
    if (!Number.isInteger(b[field])) return `${field} must be a whole number.`;
  }

  return {
    id: b.id.trim(),
    lane: b.lane as Lane,
    startWeek: b.startWeek as number,
    endWeek: b.endWeek as number,
    position: b.position as number,
  };
}

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

  const parsed = parseBody(raw);
  if (typeof parsed === "string") {
    return NextResponse.json({ ok: false, reason: parsed }, { status: 400 });
  }

  try {
    await updateRoadmapTest(parsed.id, {
      lane: parsed.lane,
      startWeek: parsed.startWeek,
      endWeek: parsed.endWeek,
      position: parsed.position,
    });
  } catch (err) {
    // A caller-fixable validation problem is a 400; anything else is a genuine 500.
    if (err instanceof RoadmapValidationError) {
      return NextResponse.json({ ok: false, reason: err.message }, { status: 400 });
    }
    return NextResponse.json(
      {
        ok: false,
        reason: err instanceof Error ? err.message : "Failed to save the move.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    id: parsed.id,
    lane: parsed.lane,
    startWeek: parsed.startWeek,
    endWeek: parsed.endWeek,
    position: parsed.position,
    savedAt: new Date().toISOString(),
  });
}
