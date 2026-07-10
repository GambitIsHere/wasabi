// ============================================================================
// Experiment backlog — assembles Wasabi's test backlog from YouTrack tickets.
// ----------------------------------------------------------------------------
// The org files A/B tests as ordinary tickets scattered across 41 projects,
// almost always as "create a new theme → run the VWO split" — which is exactly
// Wasabi's variant→?theme= model. Until a dedicated `experiment` TAG exists in
// YouTrack, this nets that testing signal heuristically (A/B · VWO · experiment
// · split · new-theme) and de-noises the obvious non-experiments (test
// credentials, hotfixes, migrations, investigations).
//
// To switch to the clean, tag-based source in ONE env change, set
//   YOUTRACK_BACKLOG_QUERY="tag: experiment"
// once the tag is backfilled. Everything downstream is unchanged.
// ============================================================================
import { searchIssues, YT_CONFIGURED, type YouTrackIssue } from "@/lib/youtrack";
import { THEME_SLUG_RE } from "@/lib/mgmt";

export interface BacklogTicket extends YouTrackIssue {
  /** Wasabi business label derived from the YouTrack project. */
  business: string;
}

export interface Backlog {
  configured: boolean;
  /** Where the list came from — the env tag query, or the keyword heuristic. */
  source: "tag-query" | "heuristic";
  /** Human-readable description of the query used (for the UI footer). */
  query: string;
  /** Whether only unresolved tickets were requested. */
  openOnly: boolean;
  tickets: BacklogTicket[];
  generatedAtMs: number;
}

// YouTrack project shortName → Wasabi business label (see lib/mgmt BUSINESSES).
// GC is mapped to Top Up: every GC ticket in practice is "TU - …" work.
const PROJECT_BUSINESS: Record<string, string> = {
  TU: "Top Up",
  TUM: "Top Up",
  GC: "Top Up",
  AC: "Airport Check-In",
  AS: "Airport Security",
  PDF: "PDF SaaS",
  GT: "Global Tickets",
  OV: "Global Visa",
  AL: "Airport Lounges",
};

// Cross-cutting projects (GP / GAPI / CAPARIKA / …) prefix the business in the
// summary itself ("TU | …", "AC - …", "WePDF | …"). Use that when the project
// isn't already a business-specific one.
const SUMMARY_BUSINESS: Record<string, string> = {
  TU: "Top Up",
  GC: "Top Up",
  AC: "Airport Check-In",
  AS: "Airport Security",
  PDF: "PDF SaaS",
  WEPDF: "PDF SaaS",
  GT: "Global Tickets",
  OV: "Global Visa",
  AL: "Airport Lounges",
  RL: "Reverse Lookup",
  RLW: "Reverse Lookup",
};

function businessFromSummary(summary: string): string | null {
  const m = summary.match(/^\s*(TU|AC|AS|PDF|WePDF|GT|RLW|RL|AL|OV|GC)\b/i);
  return m ? (SUMMARY_BUSINESS[m[1].toUpperCase()] ?? null) : null;
}

function businessFor(issue: YouTrackIssue): string {
  return (
    PROJECT_BUSINESS[issue.project] ??
    businessFromSummary(issue.summary) ??
    `${issue.projectName || issue.project} (cross-business)`
  );
}

// ---------------------------------------------------------------------------
// Prefill helpers — turn a backlog ticket into seed values for the
// /experiments/new form (carried as query params on the "+ Test" link).
// Pure (no I/O), so they're trivially testable and safe to import anywhere.
// ---------------------------------------------------------------------------

/** A clean experiment-name suggestion: the summary minus a leading business prefix. */
export function suggestedName(summary: string): string {
  return summary
    .replace(
      /^\s*(TU|TUM|AC|AS|PDF|WePDF|GT|RLW|RL|AL|OV|GC|OS|IQ|DL|AICHAT)\s*[-|:–]\s*/i,
      "",
    )
    .trim()
    .slice(0, 120);
}

/**
 * Best-effort `?theme=` slug from ticket text (summary + description); null if
 * none is confidently found. Looks for an explicit `theme=`/`theme:` cue first,
 * then a slug-shaped token (`xx_…`) from the known business prefixes. Always
 * validated against THEME_SLUG_RE so an invalid guess never reaches the form.
 */
export function suggestedThemeSlug(text: string): string | null {
  const explicit = text.match(/theme\s*[=:]\s*([a-z][a-z0-9_-]{1,49})/i);
  if (explicit && THEME_SLUG_RE.test(explicit[1].toLowerCase())) {
    return explicit[1].toLowerCase();
  }
  const shaped = text.match(
    /\b((?:tu|ac|as|pdf|rl|rlw|gt|gc|al|ov)_[a-z0-9_]{1,46})\b/i,
  );
  if (shaped && THEME_SLUG_RE.test(shaped[1].toLowerCase())) {
    return shaped[1].toLowerCase();
  }
  return null;
}

// Keyword terms run as separate full-text queries, then merged + deduped —
// this matches the recall of the manual census and avoids fragile OR syntax.
const HEURISTIC_TERMS = ["A/B", "VWO", "split test", "experiment", "new theme"];

// Summaries the keyword net catches that are NOT experiments.
const NOISE_RE =
  /test credentials|^\s*\[|^\s*hotfix|migration|investigate|monitoring|sentry/i;
// A ticket must show a real testing signal (summary OR description) to qualify.
const SIGNAL_RE =
  /a\/b|\bab test\b|vwo|experiment|split test|\bnew theme\b|\bvariant\b/i;

function isExperiment(t: YouTrackIssue): boolean {
  if (NOISE_RE.test(t.summary)) return false;
  // Signal must be in the TITLE — description mentions ("…we A/B tested X…") are
  // too loose and drag in perf / KPI / infra tickets that merely reference a test.
  return SIGNAL_RE.test(t.summary);
}

// 60s in-memory cache (per open/all view) so refreshing the page or hitting the
// API repeatedly doesn't hammer YouTrack. Mirrors the engine's TTL-cache habit.
const cache = new Map<string, { at: number; data: Backlog }>();
const TTL_MS = 60_000;

export async function getExperimentBacklog(
  opts: { open?: boolean; refresh?: boolean } = {},
): Promise<Backlog> {
  const openOnly = opts.open ?? true;
  const cacheKey = `open:${openOnly}`;
  const now = Date.now();

  if (!opts.refresh) {
    const hit = cache.get(cacheKey);
    if (hit && now - hit.at < TTL_MS) return hit.data;
  }

  if (!YT_CONFIGURED) {
    return {
      configured: false,
      source: "heuristic",
      query: "",
      openOnly,
      tickets: [],
      generatedAtMs: now,
    };
  }

  const envQuery = process.env.YOUTRACK_BACKLOG_QUERY?.trim();
  const openSuffix = openOnly ? " #Unresolved" : "";

  let tickets: YouTrackIssue[];
  let source: Backlog["source"];
  let query: string;

  if (envQuery) {
    // Clean, tag-based path. Only append #Unresolved if the query doesn't
    // already constrain state.
    source = "tag-query";
    const alreadyScoped = /#(unresolved|resolved)|\bstate\s*:/i.test(envQuery);
    query = openOnly && !alreadyScoped ? `${envQuery} #Unresolved` : envQuery;
    tickets = await searchIssues(query, { top: 200 }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[backlog] tag-query failed:", message);
      return [] as YouTrackIssue[];
    });
  } else {
    // Heuristic net: one query per term, merge + dedupe + de-noise.
    source = "heuristic";
    query =
      HEURISTIC_TERMS.map((t) => `“${t}”`).join(" · ") +
      (openOnly ? " · open only" : " · incl. history");
    const lists = await Promise.all(
      HEURISTIC_TERMS.map((t) =>
        searchIssues(`${t}${openSuffix}`, { top: 100 }).catch(
          () => [] as YouTrackIssue[],
        ),
      ),
    );
    const seen = new Map<string, YouTrackIssue>();
    for (const list of lists) for (const it of list) if (!seen.has(it.id)) seen.set(it.id, it);
    tickets = [...seen.values()].filter(isExperiment);
  }

  // Open first, then most-recently-updated.
  tickets.sort(
    (a, b) => Number(a.resolved) - Number(b.resolved) || b.updatedMs - a.updatedMs,
  );

  const data: Backlog = {
    configured: true,
    source,
    query,
    openOnly,
    tickets: tickets.map((t) => ({ ...t, business: businessFor(t) })),
    generatedAtMs: now,
  };
  cache.set(cacheKey, { at: now, data });
  return data;
}
