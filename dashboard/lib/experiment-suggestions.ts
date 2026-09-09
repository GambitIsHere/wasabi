// ============================================================================
// Suggested experiments — the roadmap surface of the YouTrack backlog scan.
// ----------------------------------------------------------------------------
// This does NOT re-scan YouTrack. It REUSES lib/backlog.getExperimentBacklog()
// (the all-projects A/B keyword net, its noise filter, dedupe and per-business
// tagging, plus the YOUTRACK_BACKLOG_QUERY="tag: experiment" clean-source
// switch) and layers on the two things the roadmap needs the backlog page
// doesn't:
//   * prefill params for /experiments/new (business / name / theme / ticket),
//   * de-duplication against work already done — a ticket that already has a
//     live experiment ("already promoted"), and an arm that already has a build
//     ticket in the ledger ("already filed").
//
// Every enrichment degrades independently: if the experiments read or the ledger
// read fails, the suggestions still render (just without that flag), so the
// roadmap page never breaks on a DB blip.
//
// SERVER-ONLY: pulls the ledger + experiment store (both hit the DB).
// ============================================================================
import {
  getExperimentBacklog,
  suggestedName,
  suggestedThemeSlug,
  type Backlog,
} from "./backlog";
import { listExperiments } from "./store";
import { listBuildTickets, type BuildTicketRow } from "./build-ticket-store";

export interface PromoteParams {
  business: string;
  name: string;
  ticket: string;
  theme?: string;
}

export interface ExperimentSuggestion {
  /** Readable YouTrack id, e.g. "GP-573". */
  ticket: string;
  url: string;
  business: string;
  summary: string;
  /** Clean name suggestion (summary minus the business prefix). */
  name: string;
  /** Best-effort arm slug from the ticket text, or null. */
  themeSlug: string | null;
  resolved: boolean;
  /** Query params for the /experiments/new deep link. */
  promote: PromoteParams;
  /** True when a live experiment already references this ticket. */
  alreadyPromoted: boolean;
  /** The ledger row for (ticket, themeSlug), when a build ticket already exists. */
  buildTicket: BuildTicketRow | null;
}

export interface Suggestions {
  configured: boolean;
  source: Backlog["source"];
  query: string;
  suggestions: ExperimentSuggestion[];
  generatedAtMs: number;
}

const TICKET_ID_RE = /\b([A-Za-z][A-Za-z0-9]*-\d+)\b/;

/** Pull the readable ticket id out of a bare id OR a full YouTrack issue URL. */
export function extractTicketId(youtrackTicket: string): string | null {
  const m = youtrackTicket.match(TICKET_ID_RE);
  return m ? m[1].toUpperCase() : null;
}

/** The set of ticket ids that already have a live experiment. Best-effort — an
 *  empty set on a read failure means nothing is flagged promoted (safe: the UI
 *  simply offers a promote it might not need, never hides a real gap). */
async function promotedTicketIds(): Promise<Set<string>> {
  try {
    const experiments = await listExperiments();
    const ids = new Set<string>();
    for (const e of experiments) {
      const id = extractTicketId(e.youtrackTicket ?? "");
      if (id) ids.add(id);
    }
    return ids;
  } catch {
    return new Set<string>();
  }
}

/** (sourceTicket|themeSlug) → ledger row, best-effort. */
async function ledgerByKey(): Promise<Map<string, BuildTicketRow>> {
  try {
    const rows = await listBuildTickets();
    const map = new Map<string, BuildTicketRow>();
    for (const r of rows) map.set(`${r.sourceTicket}|${r.themeSlug}`, r);
    return map;
  } catch {
    return new Map<string, BuildTicketRow>();
  }
}

/**
 * The roadmap's suggested experiments, enriched for promote + dedupe. Reuses the
 * backlog scan wholesale; adds the prefill params and the already-done flags.
 */
export async function getExperimentSuggestions(
  opts: { open?: boolean; refresh?: boolean } = {},
): Promise<Suggestions> {
  const backlog = await getExperimentBacklog(opts);

  // Nothing to enrich — skip the two DB reads entirely (YouTrack off, or an
  // empty backlog), so the roadmap page pays nothing for a feature with no data.
  if (backlog.tickets.length === 0) {
    return {
      configured: backlog.configured,
      source: backlog.source,
      query: backlog.query,
      suggestions: [],
      generatedAtMs: backlog.generatedAtMs,
    };
  }

  const [promoted, ledger] = await Promise.all([
    promotedTicketIds(),
    ledgerByKey(),
  ]);

  const suggestions: ExperimentSuggestion[] = backlog.tickets.map((t) => {
    const themeSlug = suggestedThemeSlug(`${t.summary} ${t.description}`);
    const name = suggestedName(t.summary);
    const ticketId = t.id.toUpperCase();
    const buildTicket = themeSlug
      ? ledger.get(`${t.id}|${themeSlug}`) ?? null
      : null;
    return {
      ticket: t.id,
      url: t.url,
      business: t.business,
      summary: t.summary,
      name,
      themeSlug,
      resolved: t.resolved,
      promote: {
        business: t.business,
        name,
        ticket: t.id,
        ...(themeSlug ? { theme: themeSlug } : {}),
      },
      alreadyPromoted: promoted.has(ticketId),
      buildTicket,
    };
  });

  return {
    configured: backlog.configured,
    source: backlog.source,
    query: backlog.query,
    suggestions,
    generatedAtMs: backlog.generatedAtMs,
  };
}
