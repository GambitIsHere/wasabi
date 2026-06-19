// POST /api/capture — mirrors engine/src/api.ts handleCapture over HTTP.
// Body: { distinctId, event, properties? } → { status: 1 }.
// In-memory log for the spike (resets per server process). CORS permissive.
import { NextResponse } from "next/server";
import { handleCapture } from "@/lib/engine/handlers";
import type { CaptureRequest } from "@/lib/engine/wire";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Partial<CaptureRequest>;
  try {
    body = (await request.json()) as Partial<CaptureRequest>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const { distinctId, event } = body;
  if (typeof distinctId !== "string" || distinctId.length === 0) {
    return NextResponse.json(
      { error: "distinctId (non-empty string) is required" },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  if (typeof event !== "string" || event.length === 0) {
    return NextResponse.json(
      { error: "event (non-empty string) is required" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const result = handleCapture({
    distinctId,
    event,
    properties: body.properties,
    timestamp: body.timestamp,
  });

  return NextResponse.json(result, { headers: CORS_HEADERS });
}
