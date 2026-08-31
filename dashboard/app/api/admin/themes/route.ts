// GET /api/admin/themes — the live Theme slug catalog from global-api (via
// Metabase). Used to build the variant→theme-slug map that attaches payment
// reads to the archived billing tests. Auth-gated by middleware (not public).
// Degrades cleanly: no METABASE_API_KEY → { available:false, reason }.
import { NextResponse } from "next/server";
import { runMetabaseSelect } from "@/lib/metabase";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const outcome = await runMetabaseSelect(
    `SELECT slug, name FROM "Theme" ORDER BY slug`,
  );
  return NextResponse.json(outcome);
}
