// POST /api/admin/attach-payment — attach the live payment read (auth rate,
// R1–R3 rebill collection, net revenue per acquired) from global-api onto an
// already-imported (VWO) archived experiment's variants.
//
// This is the "what VWO can't see" join: VWO knows clicks and conversions; the
// payment read knows which variant actually collected money, cycle by cycle. It
// maps each archived variant to the global-api theme slug(s) it corresponds to,
// runs the extended Metabase results query over the window, sums across a
// variant's slugs, recomputes the rates, and writes them onto the variants.
//
// Body:
//   {
//     key: string,                          // archived experiment key
//     window?: { start: string, end?: string }, // ISO; default start = exp.startDate
//     slugMap: Record<string, string[]>     // archived variant key → theme slug(s)
//   }
//
// Auth is enforced by the global NextAuth middleware (this path is NOT in
// PUBLIC_PREFIXES). Degrades gracefully: with no METABASE_API_KEY it returns
// { ok: false, reason } and never throws.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  getArchived,
  attachPaymentMetrics,
  type VariantPaymentMetrics,
} from "@/lib/archive";
import { runPaymentMetrics, type SlugPaymentRow } from "@/lib/metabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AttachBody {
  key: string;
  window?: { start?: string; end?: string };
  slugMap: Record<string, string[]>;
}

/** Validate + narrow the request body. Returns null on any shape violation. */
function parseBody(body: unknown): AttachBody | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.key !== "string" || b.key.trim().length === 0) return null;

  const slugMapRaw = b.slugMap;
  if (!slugMapRaw || typeof slugMapRaw !== "object" || Array.isArray(slugMapRaw)) {
    return null;
  }
  const slugMap: Record<string, string[]> = {};
  for (const [variantKey, slugs] of Object.entries(
    slugMapRaw as Record<string, unknown>,
  )) {
    if (!Array.isArray(slugs)) return null;
    const clean = slugs.filter(
      (s): s is string => typeof s === "string" && s.trim().length > 0,
    );
    slugMap[variantKey] = clean;
  }
  if (Object.keys(slugMap).length === 0) return null;

  let window: AttachBody["window"];
  if (b.window !== undefined) {
    if (!b.window || typeof b.window !== "object") return null;
    const w = b.window as Record<string, unknown>;
    if (w.start !== undefined && typeof w.start !== "string") return null;
    if (w.end !== undefined && typeof w.end !== "string") return null;
    window = { start: w.start as string | undefined, end: w.end as string | undefined };
  }

  return { key: b.key.trim(), window, slugMap };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Sum SlugPaymentRow counts across a variant's slugs, then recompute rates. */
function foldVariant(
  variantKey: string,
  slugs: string[],
  bySlug: Map<string, SlugPaymentRow>,
): VariantPaymentMetrics & { slugs: string[]; matchedSlugs: string[] } {
  const matched: string[] = [];
  const acc = {
    appsAcquired: 0,
    firstPaid: 0,
    firstFailed: 0,
    r1Attempts: 0,
    r1Ok: 0,
    r2Attempts: 0,
    r2Ok: 0,
    r3Attempts: 0,
    r3Ok: 0,
    netRevenueGbp: 0,
  };
  for (const slug of slugs) {
    const row = bySlug.get(slug);
    if (!row) continue;
    matched.push(slug);
    acc.appsAcquired += row.appsAcquired;
    acc.firstPaid += row.firstPaid;
    acc.firstFailed += row.firstFailed;
    acc.r1Attempts += row.r1Attempts;
    acc.r1Ok += row.r1Ok;
    acc.r2Attempts += row.r2Attempts;
    acc.r2Ok += row.r2Ok;
    acc.r3Attempts += row.r3Attempts;
    acc.r3Ok += row.r3Ok;
    acc.netRevenueGbp += row.netRevenueGbp;
  }

  const authDenom = acc.firstPaid + acc.firstFailed;
  const rate = (ok: number, attempts: number): number | null =>
    attempts > 0 ? round((100 * ok) / attempts, 1) : null;

  return {
    key: variantKey,
    authRate: authDenom > 0 ? round((100 * acc.firstPaid) / authDenom, 1) : null,
    rebillR1: rate(acc.r1Ok, acc.r1Attempts),
    rebillR2: rate(acc.r2Ok, acc.r2Attempts),
    rebillR3: rate(acc.r3Ok, acc.r3Attempts),
    netRevPerAcquired:
      acc.appsAcquired > 0 ? round(acc.netRevenueGbp / acc.appsAcquired, 2) : null,
    slugs,
    matchedSlugs: matched,
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Body is not valid JSON." },
      { status: 400 },
    );
  }

  const body = parseBody(raw);
  if (!body) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "Expected { key: string, window?: { start, end? }, slugMap: { <variantKey>: string[] } } with at least one variant.",
      },
      { status: 400 },
    );
  }

  const experiment = await getArchived(body.key);
  if (!experiment) {
    return NextResponse.json(
      { ok: false, reason: `Unknown archived experiment "${body.key}"` },
      { status: 404 },
    );
  }

  const start = body.window?.start ?? experiment.startDate ?? "";
  if (!start) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "No cohort start date — pass window.start or set the experiment's startDate.",
      },
      { status: 400 },
    );
  }

  // Every distinct slug across all variants, queried in one round-trip.
  const allSlugs = Array.from(
    new Set(Object.values(body.slugMap).flat()),
  );
  if (allSlugs.length === 0) {
    return NextResponse.json(
      { ok: false, reason: "slugMap has no theme slugs." },
      { status: 400 },
    );
  }

  const outcome = await runPaymentMetrics(allSlugs, start, body.window?.end);
  if (!outcome.available) {
    // No key, no data, or a query error — a clean, non-throwing empty state.
    return NextResponse.json({ ok: false, key: body.key, reason: outcome.reason });
  }

  const bySlug = new Map<string, SlugPaymentRow>();
  for (const row of outcome.rows) bySlug.set(row.themeSlug, row);

  const folded = Object.entries(body.slugMap).map(([variantKey, slugs]) =>
    foldVariant(variantKey, slugs, bySlug),
  );

  const written = await attachPaymentMetrics(
    body.key,
    folded.map((f) => ({
      key: f.key,
      authRate: f.authRate,
      rebillR1: f.rebillR1,
      rebillR2: f.rebillR2,
      rebillR3: f.rebillR3,
      netRevPerAcquired: f.netRevPerAcquired,
    })),
  );
  const writtenSet = new Set(written);

  return NextResponse.json({
    ok: true,
    key: body.key,
    window: { start, end: body.window?.end ?? null },
    attached: folded.map((f) => ({
      key: f.key,
      slugs: f.slugs,
      matchedSlugs: f.matchedSlugs,
      written: writtenSet.has(f.key),
      authRate: f.authRate,
      rebillR1: f.rebillR1,
      rebillR2: f.rebillR2,
      rebillR3: f.rebillR3,
      netRevPerAcquired: f.netRevPerAcquired,
    })),
    ranAt: new Date().toISOString(),
  });
}
