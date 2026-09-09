// /api/roadmap/build-ticket
// ----------------------------------------------------------------------------
// GET  — write-path meta for the "create build ticket" UI: whether the YouTrack
//        write path is configured, and (when it is) the GP team's users for the
//        watcher/tag picker. Admin-gated. NEVER creates anything.
// POST — create ONE YouTrack build ticket for a NOT-BUILT arm, behind the admin
//        gate AND the write gate (token + kill-switch). Idempotent via the
//        ledger: re-promoting the same (ticket, slug) returns the existing issue
//        instead of filing a second one. Assignee is omitted (Unassigned);
//        watchers are added from the picker, best-effort.
//
// FAIL-SAFE: when the write path is off (no token, or WASABI_YT_WRITE_ENABLED
// unset), GET reports it disabled with a reason and POST refuses with 409 — the
// app never breaks, and read/surface/promote/readiness keep working without a
// write token.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/authz";
import { checkVariantReadiness } from "@/lib/variant-readiness";
import { buildBuildTicketPayload } from "@/lib/build-ticket-payload";
import {
  claimBuildTicket,
  markBuildTicketCreated,
  releaseBuildTicket,
} from "@/lib/build-ticket-store";
import {
  ytWriteConfigured,
  ytWriteDisabledReason,
  resolveProjectId,
  getProjectTeamUsers,
  createIssue,
  addWatcher,
  YouTrackWriteError,
} from "@/lib/youtrack-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The project whose team seeds the watcher picker — this loop files front-end
// variant builds into GP.
const PICKER_PROJECT = "GP";

export async function GET(): Promise<NextResponse> {
  const gate = await requireRole("admin");
  if (!gate.ok) {
    return NextResponse.json(
      { writeConfigured: false, reason: gate.error, users: [] },
      { status: gate.status },
    );
  }

  if (!ytWriteConfigured()) {
    return NextResponse.json({
      writeConfigured: false,
      reason: ytWriteDisabledReason(),
      project: PICKER_PROJECT,
      users: [],
    });
  }

  // Configured — try to load the picker list. A YouTrack read failure here must
  // not present as "not configured": report configured with an empty list + note.
  try {
    const projectId = await resolveProjectId(PICKER_PROJECT);
    const users = projectId ? await getProjectTeamUsers(projectId) : [];
    return NextResponse.json({
      writeConfigured: true,
      reason: null,
      project: PICKER_PROJECT,
      users,
    });
  } catch (err) {
    return NextResponse.json({
      writeConfigured: true,
      reason: null,
      project: PICKER_PROJECT,
      users: [],
      note: err instanceof Error ? err.message : "Could not load the team list.",
    });
  }
}

interface Body {
  sourceTicket: string;
  business: string;
  experimentName: string;
  themeSlug: string;
  watchers?: string[];
}

function parseBody(raw: unknown): Body | string {
  if (!raw || typeof raw !== "object") return "Body must be a JSON object.";
  const b = raw as Record<string, unknown>;
  for (const field of ["sourceTicket", "business", "experimentName", "themeSlug"] as const) {
    if (typeof b[field] !== "string" || (b[field] as string).trim().length === 0) {
      return `${field} is required.`;
    }
  }
  let watchers: string[] = [];
  if (b.watchers !== undefined) {
    if (!Array.isArray(b.watchers) || b.watchers.some((w) => typeof w !== "string")) {
      return "watchers must be an array of login strings.";
    }
    watchers = (b.watchers as string[]).map((w) => w.trim()).filter(Boolean);
  }
  return {
    sourceTicket: (b.sourceTicket as string).trim(),
    business: (b.business as string).trim(),
    experimentName: (b.experimentName as string).trim(),
    themeSlug: (b.themeSlug as string).trim(),
    watchers,
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await requireRole("admin");
  if (!gate.ok) {
    return NextResponse.json({ ok: false, reason: gate.error }, { status: gate.status });
  }

  // Write gate — the fail-safe. Refuse cleanly (409) rather than crashing.
  if (!ytWriteConfigured()) {
    return NextResponse.json(
      { ok: false, reason: ytWriteDisabledReason() },
      { status: 409 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "Body is not valid JSON." }, { status: 400 });
  }
  const parsed = parseBody(raw);
  if (typeof parsed === "string") {
    return NextResponse.json({ ok: false, reason: parsed }, { status: 400 });
  }

  // Re-verify readiness server-side: only a NOT-BUILT arm gets a build ticket.
  // A built or unknown arm is refused, so the tool never files a ticket for work
  // that's already done (or that it can't verify).
  const readiness = checkVariantReadiness(parsed.business, parsed.themeSlug);
  if (readiness.state !== "not-built") {
    return NextResponse.json(
      {
        ok: false,
        reason: `Refusing to file a build ticket: the arm is "${readiness.state}", not "not-built". ${readiness.reason}`,
        readiness,
      },
      { status: 409 },
    );
  }

  const payload = buildBuildTicketPayload({
    sourceTicket: parsed.sourceTicket,
    business: parsed.business,
    experimentName: parsed.experimentName,
    themeSlug: parsed.themeSlug,
    repo: readiness.repo,
    readinessReason: readiness.reason,
    route: "frontend",
  });

  // Claim the ledger slot FIRST (idempotency). If it's already claimed, return
  // the existing ticket without filing a duplicate.
  const claim = await claimBuildTicket({
    sourceTicket: parsed.sourceTicket,
    themeSlug: parsed.themeSlug,
    business: parsed.business,
    project: payload.projectShortName,
    summary: payload.summary,
    createdBy: gate.userId,
  });
  if (!claim.claimed) {
    return NextResponse.json({
      ok: true,
      alreadyExisted: true,
      ticket: claim.existing.createdTicket,
      status: claim.existing.status,
      reason:
        claim.existing.status === "created"
          ? `A build ticket already exists for ${parsed.sourceTicket} / ${parsed.themeSlug}.`
          : `A build ticket for ${parsed.sourceTicket} / ${parsed.themeSlug} is already being created.`,
    });
  }

  // We own the slot — resolve the project id and file the issue.
  try {
    const projectId = await resolveProjectId(payload.projectShortName);
    if (!projectId) {
      await releaseBuildTicket(claim.id);
      return NextResponse.json(
        { ok: false, reason: `YouTrack project "${payload.projectShortName}" was not found.` },
        { status: 502 },
      );
    }
    const created = await createIssue({
      projectId,
      summary: payload.summary,
      description: payload.description,
      customFields: payload.customFields,
      tags: payload.tags,
    });
    await markBuildTicketCreated(claim.id, created.idReadable);

    // Watchers — best-effort; a failed add never undoes the created issue.
    const watcherResults: { login: string; ok: boolean; error?: string }[] = [];
    for (const login of parsed.watchers ?? []) {
      try {
        await addWatcher(created.idReadable, login);
        watcherResults.push({ login, ok: true });
      } catch (err) {
        watcherResults.push({
          login,
          ok: false,
          error: err instanceof Error ? err.message : "add watcher failed",
        });
      }
    }

    return NextResponse.json({
      ok: true,
      alreadyExisted: false,
      ticket: created.idReadable,
      url: created.url,
      project: payload.projectShortName,
      watchers: watcherResults,
    });
  } catch (err) {
    // Filing failed — release the claim so a retry can re-claim the slot.
    await releaseBuildTicket(claim.id).catch(() => {});
    const status = err instanceof YouTrackWriteError ? 502 : 500;
    return NextResponse.json(
      { ok: false, reason: err instanceof Error ? err.message : "Failed to create the build ticket." },
      { status },
    );
  }
}
