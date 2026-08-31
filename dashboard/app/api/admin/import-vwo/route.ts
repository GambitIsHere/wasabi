// POST /api/admin/import-vwo — upsert archived (past) experiments imported from
// VWO / Wingify. Idempotent: re-posting the same campaign key overwrites it.
//
// Body: either a bare array of ArchivedInput, or { experiments: ArchivedInput[] }.
//
// Auth is enforced by the global NextAuth middleware (this path is NOT in
// PUBLIC_PREFIXES, so unauthenticated requests get redirected to /signin before
// this handler runs).
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  countArchived,
  upsertManyArchived,
  type ArchivedInput,
} from "@/lib/archive";

export const dynamic = "force-dynamic";

function extractExperiments(body: unknown): ArchivedInput[] | null {
  const raw = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { experiments?: unknown }).experiments)
      ? (body as { experiments: unknown[] }).experiments
      : null;
  if (!raw) return null;
  // Shallow shape guard — every item must at least name a campaign, its
  // business, and carry variants. The store normalises the rest.
  const valid = raw.every(
    (e) =>
      e &&
      typeof e === "object" &&
      typeof (e as ArchivedInput).name === "string" &&
      typeof (e as ArchivedInput).business === "string" &&
      Array.isArray((e as ArchivedInput).variants),
  );
  return valid ? (raw as ArchivedInput[]) : null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Body is not valid JSON." },
      { status: 400 },
    );
  }

  const experiments = extractExperiments(body);
  if (!experiments) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Expected an array of experiments (or { experiments: [...] }), each with name, business and variants.",
      },
      { status: 400 },
    );
  }

  try {
    const before = await countArchived();
    const result = await upsertManyArchived(experiments);
    const after = await countArchived();
    return NextResponse.json({
      ok: true,
      before,
      after,
      imported: result.imported,
      failed: result.failed,
      ranAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/admin/import-vwo] failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
