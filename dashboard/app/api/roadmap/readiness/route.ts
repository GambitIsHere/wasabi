// GET /api/roadmap/readiness?business=<label>&slug=<theme-slug>
// ----------------------------------------------------------------------------
// Read-only variant-readiness check for a suggested experiment arm: is the arm's
// theme slug already built in its storefront, a data-only recombination, or does
// it need a build ticket? See lib/variant-readiness.ts for the heuristic.
//
// Behind the auth middleware (this path is NOT on the public /api/decide +
// /api/capture allowlist), so it stays internal — but it is NOT role-gated: it
// only READS (a filesystem scan of the storefront checkout), mirrors the backlog
// read (/api/tickets), and feeds the roadmap card every signed-in member sees.
// The WRITE action (POST /api/roadmap/build-ticket) is the admin-gated one.
//
// Never touches YouTrack and never writes anything. Returns "unknown" (never an
// error) when the storefront checkout isn't on disk — e.g. the prod runtime.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { checkVariantReadiness } from "@/lib/variant-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const business = req.nextUrl.searchParams.get("business")?.trim() ?? "";
  const slug = req.nextUrl.searchParams.get("slug")?.trim() ?? "";
  if (!business || !slug) {
    return NextResponse.json(
      { ok: false, reason: "business and slug query params are required." },
      { status: 400 },
    );
  }
  try {
    const readiness = checkVariantReadiness(business, slug);
    return NextResponse.json({ ok: true, readiness });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        reason: err instanceof Error ? err.message : "Readiness check failed.",
      },
      { status: 500 },
    );
  }
}
