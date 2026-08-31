// POST /api/capture — mirrors engine/src/api.ts handleCapture over HTTP.
// Body: { distinctId, event, properties? } → { status: 1 }.
//
// Persistence: each accepted event is now written to the `event` table (the
// assignment side of the live cockpit feed — see lib/events.ts). The write is
// FAIL-OPEN: it is wrapped in try/catch so a storefront capture never fails or
// (beyond the single insert round-trip) slows because of persistence, and the
// response contract — `{ status: 1 }`, the 204 OPTIONS, the permissive CORS — is
// byte-for-byte unchanged. This endpoint is public + unauthenticated and called
// cross-origin by storefronts, so nothing here may throw back to the caller.
import { NextResponse } from "next/server";
import { handleCapture } from "@/lib/engine/handlers";
import { persistEvent, type EventKind } from "@/lib/events";
import type { CaptureRequest } from "@/lib/engine/wire";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Property parsing — tolerant, because the storefront SDK is external to this
// repo and no single canonical property spelling is guaranteed. We accept the
// common spellings (snake / camel / PostHog `$feature_flag*`) for the three
// attribution fields, and derive `kind` from the event name. A field that is
// absent or the wrong type simply stores NULL; it never rejects the capture.
// ---------------------------------------------------------------------------

function coerceStr(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function firstOf(
  props: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | null {
  if (!props) return null;
  for (const k of keys) {
    const v = coerceStr(props[k]);
    if (v !== null) return v;
  }
  return null;
}

const EXPERIMENT_KEYS = [
  "experiment_key",
  "experimentKey",
  "experiment",
  "$experiment",
  "$feature_flag",
  "feature_flag",
  "flag",
] as const;
const VARIANT_KEYS = [
  "variant",
  "$variant",
  "arm",
  "$feature_flag_response",
  "feature_flag_response",
  "feature_flag_variant",
] as const;
const BUSINESS_KEYS = ["business", "$business", "brand"] as const;

/** An event is an assignment when its name says so; everything else is a conversion. */
function classify(event: string): EventKind {
  const e = event.toLowerCase();
  if (e === "$assignment" || e === "$feature_flag_called" || e.includes("assign")) {
    return "assignment";
  }
  return "conversion";
}

/** Normalise the wire timestamp to a UTC ISO string; fall back to now(). */
function normaliseTs(ts: unknown): string {
  const raw = coerceStr(ts);
  if (raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

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

  // Fail-open persistence: one row into the `event` table. Any failure is logged
  // and swallowed so the storefront still gets its `{ status: 1 }` ack unchanged.
  try {
    await persistEvent({
      ts: normaliseTs(body.timestamp),
      distinctId,
      event,
      experimentKey: firstOf(body.properties, EXPERIMENT_KEYS),
      variant: firstOf(body.properties, VARIANT_KEYS),
      business: firstOf(body.properties, BUSINESS_KEYS),
      kind: classify(event),
    });
  } catch (err) {
    console.error(
      "[capture] persist failed (ignored, fail-open):",
      err instanceof Error ? err.message : err,
    );
  }

  return NextResponse.json(result, { headers: CORS_HEADERS });
}
