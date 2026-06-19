// POST /api/decide — mirrors engine/src/api.ts handleDecide over HTTP.
// Body: { distinctId, personProperties? } → { featureFlags, themes }.
// CORS permissive so any storefront origin can call it from the browser.
import { NextResponse } from "next/server";
import { handleDecide } from "@/lib/engine/handlers";
import type { DecideRequest } from "@/lib/engine/wire";

// node:crypto (SHA-1 hashing) needs the Node.js runtime, not Edge.
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
  let body: Partial<DecideRequest>;
  try {
    body = (await request.json()) as Partial<DecideRequest>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const distinctId = body.distinctId;
  if (typeof distinctId !== "string" || distinctId.length === 0) {
    return NextResponse.json(
      { error: "distinctId (non-empty string) is required" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const result = handleDecide({
    distinctId,
    personProperties: body.personProperties,
  });

  return NextResponse.json(result, { headers: CORS_HEADERS });
}
