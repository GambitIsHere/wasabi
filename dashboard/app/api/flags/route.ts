// GET /api/flags — list active experiments (debug/admin), mirrors handleFlags.
import { NextResponse } from "next/server";
import { handleFlags } from "@/lib/engine/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await handleFlags());
}
