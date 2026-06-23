// ============================================================================
// YouTrack REST client — SERVER-ONLY transport.
// ----------------------------------------------------------------------------
// Read-side plumbing so Wasabi can pull experiment context straight from the
// org's ticket tracker. Auth is a Bearer `perm-` token read from the env
// (YOUTRACK_TOKEN + YOUTRACK_HOST — set in Vercel; locally they live in
// ~/.zshrc). The token is NEVER logged or echoed. No external dependency —
// uses the global `fetch` (Next.js Node runtime).
//
// This module must only be imported from server code (route handlers / server
// components). It does no mutation: search + single-issue reads only.
// ============================================================================

const HOST = (process.env.YOUTRACK_HOST || "sanjow.youtrack.cloud")
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");
const TOKEN = process.env.YOUTRACK_TOKEN ?? "";

/** True when a token is present — callers degrade gracefully when it isn't. */
export const YT_CONFIGURED = TOKEN.length > 0;

/** Base origin, e.g. https://sanjow.youtrack.cloud */
export const YT_BASE = `https://${HOST}`;

export interface YouTrackIssue {
  /** Readable id, e.g. "AC-98". */
  id: string;
  summary: string;
  description: string;
  resolved: boolean;
  /** Project shortName, e.g. "AC". */
  project: string;
  projectName: string;
  assignee: string | null;
  ticketType: string | null;
  tags: string[];
  /** Deep link to the issue in the YouTrack UI. */
  url: string;
  updatedMs: number;
}

// The field projection requested from YouTrack. customFields carries Assignee,
// Ticket Type, etc. as {name, value} pairs (value may be a dict or scalar).
const DEFAULT_FIELDS =
  "idReadable,summary,description,resolved,updated," +
  "project(shortName,name),tags(name)," +
  "customFields(name,value(name,login,fullName))";

interface RawCustomField {
  name?: string;
  value?: unknown;
}
interface RawIssue {
  idReadable?: string;
  summary?: string;
  description?: string;
  resolved?: number | null;
  updated?: number | null;
  project?: { shortName?: string; name?: string } | null;
  tags?: Array<{ name?: string }> | null;
  customFields?: RawCustomField[] | null;
}

/** A custom-field value is either a scalar or a {name|fullName|login} dict. */
function cfText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const v = value as { name?: string; fullName?: string; login?: string };
    return v.fullName || v.name || v.login || null;
  }
  return null;
}

function normalize(raw: RawIssue): YouTrackIssue | null {
  const id = raw.idReadable;
  if (!id) return null;
  const cf = new Map<string, unknown>();
  for (const c of raw.customFields ?? []) if (c?.name) cf.set(c.name, c.value);
  return {
    id,
    summary: (raw.summary ?? "").trim(),
    description: (raw.description ?? "").trim(),
    resolved: raw.resolved != null,
    project: raw.project?.shortName ?? "?",
    projectName: raw.project?.name ?? "",
    assignee: cfText(cf.get("Assignee")),
    ticketType: cfText(cf.get("Ticket Type")) ?? cfText(cf.get("Type")),
    tags: (raw.tags ?? []).map((t) => t?.name ?? "").filter(Boolean),
    url: `${YT_BASE}/issue/${id}`,
    updatedMs: typeof raw.updated === "number" ? raw.updated : 0,
  };
}

export class YouTrackError extends Error {}

// Build the query string with literal keys (YouTrack wants a literal `$top`)
// and percent-encoded values (so `A/B`, spaces and parens survive).
async function ytFetch(
  path: string,
  params: Record<string, string>,
): Promise<unknown> {
  if (!YT_CONFIGURED) throw new YouTrackError("YOUTRACK_TOKEN is not set");
  const search = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  const res = await fetch(`${YT_BASE}/api/${path}?${search}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    // Surface status + (truncated) body — never the token.
    const body = await res.text().catch(() => "");
    throw new YouTrackError(
      `YouTrack ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
    );
  }
  return res.json();
}

/**
 * Run one YouTrack query (full query syntax) and return normalized issues.
 * A non-array response means an error / invalid query — surfaced as a throw.
 */
export async function searchIssues(
  query: string,
  opts: { top?: number; fields?: string } = {},
): Promise<YouTrackIssue[]> {
  const data = await ytFetch("issues", {
    query,
    fields: opts.fields ?? DEFAULT_FIELDS,
    $top: String(opts.top ?? 100),
  });
  if (!Array.isArray(data)) {
    const d = data as { error?: string; error_description?: string };
    throw new YouTrackError(
      d?.error_description || d?.error || "unexpected YouTrack response (not a list)",
    );
  }
  return (data as RawIssue[])
    .map(normalize)
    .filter((x): x is YouTrackIssue => x !== null);
}

/** Fetch a single issue by readable id (e.g. "AC-98"); null if not found. */
export async function getIssue(
  id: string,
  fields = DEFAULT_FIELDS,
): Promise<YouTrackIssue | null> {
  try {
    const data = await ytFetch(`issues/${encodeURIComponent(id)}`, { fields });
    if (!data || typeof data !== "object" || "error" in (data as object)) {
      return null;
    }
    return normalize(data as RawIssue);
  } catch {
    return null;
  }
}
