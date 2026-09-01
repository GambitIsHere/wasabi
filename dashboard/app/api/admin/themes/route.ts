// GET /api/admin/themes — the Theme slug catalog from global-api (via Metabase),
// scoped to the caller's own project. Used to build the variant→theme-slug map
// that attaches payment reads to the archived billing tests. Authentication is
// enforced by middleware; AUTHORIZATION (at least `admin`) and TENANT SCOPING
// are enforced here: the raw query returns the ENTIRE global Theme catalog
// (every brand's slugs), so the response is filtered to the slugs the caller's
// project already references before it leaves the server. Degrades cleanly: no
// METABASE_API_KEY → { available:false, reason }.
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/authz";
import { getProjectThemeSlugs } from "@/lib/experiments";
import { runMetabaseSelect } from "@/lib/metabase";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const gate = await requireRole("admin");
  if (!gate.ok) {
    return NextResponse.json({ available: false, reason: gate.error }, { status: gate.status });
  }

  const outcome = await runMetabaseSelect(
    `SELECT slug, name FROM "Theme" ORDER BY slug`,
  );
  if (!outcome.available) return NextResponse.json(outcome);

  // Scope the catalog to slugs this project owns — never hand one tenant the
  // full cross-brand Theme list.
  const ownedSlugs = await getProjectThemeSlugs();
  const rows = outcome.rows.filter((r) => ownedSlugs.has(String(r.slug)));
  return NextResponse.json({ available: true, rows });
}
