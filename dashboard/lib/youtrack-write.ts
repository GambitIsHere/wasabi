// ============================================================================
// YouTrack REST client — SERVER-ONLY WRITE transport (create issue + commands).
// ----------------------------------------------------------------------------
// The read twin (lib/youtrack.ts) only ever searches and reads. This module is
// the mutating side of the roadmap→YouTrack loop: it lists projects, reads a
// project's team (for the watcher/tag picker), CREATES build issues, and applies
// commands (add watcher). It is deliberately a SEPARATE module so nothing on the
// read path can accidentally mutate, and so the whole write surface is gated by
// one switch that read/surface/promote/readiness never touch.
//
// GATING — the fail-safe is the point:
//   * Base URL: prefer YOUTRACK_BASE_URL (e.g. https://sanjow.youtrack.cloud);
//     fall back to the read client's YOUTRACK_HOST so a single-var setup still
//     works. Either is normalised to a bare https origin.
//   * Token: YOUTRACK_TOKEN — the SAME env the read client uses, but a write
//     needs a token minted with create-issue + apply-command scope. The tool
//     cannot introspect a token's scopes; it only knows whether one is present.
//   * Kill-switch: WASABI_YT_WRITE_ENABLED must be "1". A read token being
//     present is NOT enough — the switch is a second, explicit gate so the write
//     path stays inert (and the "create build ticket" UI stays disabled) until
//     someone deliberately turns it on with a write-scoped token.
//
// ytWriteConfigured() is false unless BOTH the token AND the kill-switch are set.
// Every mutating call throws YouTrackWriteError when it is false, so a caller
// that forgets to check still fails closed rather than hitting YouTrack. The
// token is NEVER logged or echoed.
//
// Import only from server code (route handlers / server components).
// ============================================================================

function normalizeOrigin(raw: string): string {
  return raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

// Prefer YOUTRACK_BASE_URL; fall back to YOUTRACK_HOST (the read client's var).
const HOST = normalizeOrigin(
  process.env.YOUTRACK_BASE_URL ||
    process.env.YOUTRACK_HOST ||
    "sanjow.youtrack.cloud",
);
const TOKEN = process.env.YOUTRACK_TOKEN ?? "";
const KILL_SWITCH_ON = process.env.WASABI_YT_WRITE_ENABLED === "1";

/** Base origin for the write client, e.g. https://sanjow.youtrack.cloud */
export const YT_WRITE_BASE = `https://${HOST}`;

/** True only when a token is present AND the kill-switch is explicitly on. */
export function ytWriteConfigured(): boolean {
  return TOKEN.length > 0 && KILL_SWITCH_ON;
}

/** Why the write path is off — for a clear, non-leaky UI state. Never returns
 *  the token or any secret, only which switch is missing. */
export function ytWriteDisabledReason(): string | null {
  if (TOKEN.length === 0 && !KILL_SWITCH_ON) {
    return "YouTrack write not configured — set YOUTRACK_TOKEN (create-issue + apply-command scope) and WASABI_YT_WRITE_ENABLED=1.";
  }
  if (TOKEN.length === 0) {
    return "YouTrack write not configured — YOUTRACK_TOKEN is not set.";
  }
  if (!KILL_SWITCH_ON) {
    return "YouTrack write is switched off — set WASABI_YT_WRITE_ENABLED=1 to enable it.";
  }
  return null;
}

export class YouTrackWriteError extends Error {}

function assertConfigured(): void {
  if (!ytWriteConfigured()) {
    throw new YouTrackWriteError(
      ytWriteDisabledReason() ?? "YouTrack write is not configured.",
    );
  }
}

async function ytWriteFetch(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; params?: Record<string, string> },
): Promise<unknown> {
  assertConfigured();
  const search = init.params
    ? "?" +
      Object.entries(init.params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&")
    : "";
  const res = await fetch(`${YT_WRITE_BASE}/api/${path}${search}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) {
    // Surface status + (truncated) body — never the token.
    const body = await res.text().catch(() => "");
    throw new YouTrackWriteError(
      `YouTrack ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
    );
  }
  // Some commands return 200 with an empty body — tolerate that.
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Projects — internal id lookup (POST /api/issues needs {project:{id}}, the
// internal id, not the shortName).
// ---------------------------------------------------------------------------

export interface YtProject {
  /** Internal id, e.g. "0-12". */
  id: string;
  /** Human short name, e.g. "GP". */
  shortName: string;
  name: string;
}

interface RawProject {
  id?: string;
  shortName?: string;
  name?: string;
  archived?: boolean;
}

/** All (non-archived) projects, so a shortName like "GP" resolves to its id. */
export async function listProjects(): Promise<YtProject[]> {
  const data = await ytWriteFetch("admin/projects", {
    method: "GET",
    params: { fields: "id,shortName,name,archived", $top: "500" },
  });
  if (!Array.isArray(data)) return [];
  return (data as RawProject[])
    .filter((p) => p.id && p.shortName && !p.archived)
    .map((p) => ({ id: p.id!, shortName: p.shortName!, name: p.name ?? p.shortName! }));
}

/** Resolve a project shortName (e.g. "GP") to its internal id, or null. */
export async function resolveProjectId(shortName: string): Promise<string | null> {
  const wanted = shortName.trim().toUpperCase();
  const project = (await listProjects()).find(
    (p) => p.shortName.toUpperCase() === wanted,
  );
  return project?.id ?? null;
}

// ---------------------------------------------------------------------------
// Team users — the candidate watcher / tag-picker list for a project.
// ---------------------------------------------------------------------------

export interface YtUser {
  login: string;
  name: string;
}

interface RawUser {
  login?: string;
  name?: string;
  fullName?: string;
}

/** The users on a project's team — the picker list for adding watchers. */
export async function getProjectTeamUsers(projectId: string): Promise<YtUser[]> {
  const data = await ytWriteFetch(
    `admin/projects/${encodeURIComponent(projectId)}/team/users`,
    { method: "GET", params: { fields: "login,name,fullName", $top: "200" } },
  );
  if (!Array.isArray(data)) return [];
  return (data as RawUser[])
    .filter((u) => u.login)
    .map((u) => ({ login: u.login!, name: u.fullName || u.name || u.login! }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Create issue.
// ---------------------------------------------------------------------------

/** A custom-field value on create. `$type` + the value shape must match the
 *  field's own type in the target project (see lib/build-ticket-payload.ts). */
export interface IssueCustomField {
  name: string;
  $type: string;
  value: unknown;
}

export interface CreateIssueInput {
  /** Internal project id (from resolveProjectId), NOT the shortName. */
  projectId: string;
  summary: string;
  description: string;
  customFields?: IssueCustomField[];
  tags?: string[];
}

export interface CreatedIssue {
  /** Internal id, e.g. "2-1053". */
  id: string;
  /** Readable id, e.g. "GP-742". */
  idReadable: string;
  url: string;
}

/** Create a YouTrack issue. Throws YouTrackWriteError when the write path is
 *  off or the API rejects the request. Assignee is intentionally NOT set here —
 *  a build ticket defaults to Unassigned; callers add watchers separately. */
export async function createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
  const body: Record<string, unknown> = {
    project: { id: input.projectId },
    summary: input.summary,
    description: input.description,
  };
  if (input.customFields && input.customFields.length > 0) {
    body.customFields = input.customFields.map((f) => ({
      name: f.name,
      $type: f.$type,
      value: f.value,
    }));
  }
  if (input.tags && input.tags.length > 0) {
    body.tags = input.tags.map((name) => ({ name }));
  }
  const data = (await ytWriteFetch("issues", {
    method: "POST",
    params: { fields: "id,idReadable" },
    body,
  })) as { id?: string; idReadable?: string };
  if (!data.idReadable) {
    throw new YouTrackWriteError(
      "YouTrack accepted the request but returned no issue id.",
    );
  }
  return {
    id: data.id ?? "",
    idReadable: data.idReadable,
    url: `${YT_WRITE_BASE}/issue/${data.idReadable}`,
  };
}

/** Add one watcher to an issue via the commands API. Best-effort — a failed
 *  watcher add must not undo an already-created issue, so callers catch this. */
export async function addWatcher(idReadable: string, login: string): Promise<void> {
  await ytWriteFetch("commands", {
    method: "POST",
    body: {
      query: `add watcher ${login}`,
      issues: [{ idReadable }],
    },
  });
}
