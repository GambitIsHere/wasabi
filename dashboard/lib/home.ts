// ============================================================================
// Wasabi — cockpit homepage data layer (server-only).
// ----------------------------------------------------------------------------
// The single import surface for the new "cockpit" homepage. It stitches TWO
// sources into one live picture and NEVER throws — each side degrades on its own:
//
//   • ASSIGNMENT side (lib/events.ts → Postgres `event` table): who was assigned
//     to which arm, and when. Empty store → assignment fields are 0 / [].
//   • PAYMENT side (lib/metabase.ts → global-api via Metabase): auth / rebill /
//     declined + amounts, keyed by theme slug. Metabase-less (no API key locally)
//     → payment fields are 0 / null and the payment half of the feed is empty.
//
// So the page renders cleanly in every combination: locally with only the event
// store, in prod with both. SELECT-only against Metabase; the `event` table is
// the only thing Wasabi writes to.
//
// SERVER-ONLY: transitively imports lib/db.ts + lib/metabase.ts. Import from a
// server component or route handler, never a client component.
// ============================================================================
import {
  recentAssignments,
  assignmentCountsToday,
  type StoredEventRow,
} from "./events";
import { runMetabaseSelect } from "./metabase";
import { listExperiments } from "./store";
import type { StoredExperiment } from "./mgmt";

// ---------------------------------------------------------------------------
// Exported types — the contract the UI agent builds against.
// ---------------------------------------------------------------------------

/** Kind of a live-feed row. `assignment` comes from the event store; the other
 *  three are derived from Metabase Transaction rows. */
export type ActivityKind = "assignment" | "auth" | "declined" | "rebill";

/** One row in the LIVE EVENTS feed. `text` is the human line WITHOUT a leading
 *  glyph — the UI picks an icon per `kind`. Attribution fields are null when the
 *  source row carries no experiment context. */
export interface ActivityItem {
  /** UTC ISO-8601 timestamp (assignment rows are stored so; payment rows are
   *  normalised to ISO on the way through). Sortable lexicographically. */
  ts: string;
  kind: ActivityKind;
  /** e.g. "first payment authorised £39.00 on variant_19 · tu-billing-uk" or
   *  "visitor 8f3ac2b1 assigned to variant_19 · tu-billing-uk". */
  text: string;
  /** The variant key ("arm"), or null. */
  arm: string | null;
  experimentKey: string | null;
  business: string | null;
}

/** One business's assignment count. */
export interface BusinessCount {
  business: string;
  count: number;
}

/** Today's assignments (UTC day): total + a per-business split. */
export interface AssignmentsToday {
  total: number;
  byBusiness: BusinessCount[];
}

/** Everything the cockpit KPI strip + panels need, in one call. */
export interface HomeMetrics {
  /** Experiments with active = true. */
  activeTests: number;
  /** Experiments with active = false (paused / queued to launch). */
  queuedTests: number;
  /** Total assignments captured today (UTC). */
  assignmentsToday: number;
  /** Cash collected today (paid + rebill, GBP) across live-experiment slugs.
   *  0 when Metabase is unavailable. */
  collectedTodayGBP: number;
  /** First-payment successes today. 0 when Metabase is unavailable. */
  authToday: number;
  /** Rebill successes today. 0 when Metabase is unavailable. */
  rebillToday: number;
  /** Decision-inbox count — see `awaitingCallCount`. PLACEHOLDER heuristic until
   *  per-experiment verdicts are wired here (verdicts need Metabase, so this stays
   *  local-computable): active experiments running long enough to likely have a
   *  call due. */
  awaitingCall: number;
  /** Same split as AssignmentsToday.byBusiness — surfaced here for the panel. */
  byBusiness: BusinessCount[];
  /** The merged live feed (newest first). */
  feed: ActivityItem[];
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Millis for sorting; unparseable timestamps sink to the bottom. */
function sortKey(ts: string): number {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : 0;
}

/** Normalise a Metabase timestamp to a UTC ISO string when parseable, else raw. */
function toIso(ts: unknown): string {
  const raw = ts == null ? "" : String(ts);
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : raw;
}

/** Shorten a distinct id for the feed line (visitors are opaque hashes/UUIDs). */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/** UTC start-of-day as a timezone-naive TIMESTAMP literal for Metabase SQL. */
function startOfTodayTimestampLiteral(): string {
  return `${new Date().toISOString().slice(0, 10)} 00:00:00`;
}

/** SELECT-only literal list of theme slugs, single-quotes escaped (mirrors metabase.ts). */
function quoteSlugList(slugs: readonly string[]): string {
  return slugs.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ");
}

// ---------------------------------------------------------------------------
// Slug → experiment attribution, built from the ACTIVE experiments.
// A theme slug can appear in more than one experiment (e.g. a shared control
// slug); first match wins. Paused experiments are excluded — the cockpit reads
// the LIVE picture.
// ---------------------------------------------------------------------------

interface SlugAttribution {
  experimentKey: string;
  arm: string;
  business: string;
}

interface LiveSlugs {
  slugs: string[];
  map: Map<string, SlugAttribution>;
}

function buildLiveSlugs(experiments: StoredExperiment[]): LiveSlugs {
  const map = new Map<string, SlugAttribution>();
  for (const exp of experiments) {
    if (!exp.active) continue;
    for (const v of exp.variants) {
      if (!map.has(v.themeSlug)) {
        map.set(v.themeSlug, {
          experimentKey: exp.key,
          arm: v.key,
          business: exp.business,
        });
      }
    }
  }
  return { slugs: [...map.keys()], map };
}

// ---------------------------------------------------------------------------
// Assignment side → feed items
// ---------------------------------------------------------------------------

function assignmentToItem(row: StoredEventRow): ActivityItem {
  const arm = row.variant;
  const armText = arm ?? "an arm";
  const expSuffix = row.experimentKey ? ` · ${row.experimentKey}` : "";
  return {
    ts: row.ts,
    kind: "assignment",
    text: `visitor ${shortId(row.distinctId)} assigned to ${armText}${expSuffix}`,
    arm,
    experimentKey: row.experimentKey,
    business: row.business,
  };
}

// ---------------------------------------------------------------------------
// Payment side (Metabase) → feed items + today's totals
// ---------------------------------------------------------------------------

/** Map a Transaction type to its feed kind + human phrase. */
function describeTx(txType: string): { kind: ActivityKind; phrase: string } | null {
  switch (txType) {
    case "paid":
      return { kind: "auth", phrase: "first payment authorised" };
    case "failed":
      return { kind: "declined", phrase: "first payment declined" };
    case "rebill":
      return { kind: "rebill", phrase: "rebill collected" };
    case "rebill_failed":
      return { kind: "declined", phrase: "rebill declined" };
    default:
      return null;
  }
}

/** Recent Transaction rows for the live slugs → feed items. Metabase-less → []. */
async function recentPayments(
  live: LiveSlugs,
  limit: number,
): Promise<ActivityItem[]> {
  if (live.slugs.length === 0) return [];
  const slugList = quoteSlugList(live.slugs);
  const sql = `
WITH live_apps AS (
  SELECT a."applicationId" AS application_id, th."slug" AS theme_slug
  FROM "Application" a
  JOIN "Theme" th ON th."themeId" = a."themeId"
  WHERE th."slug" IN (${slugList})
)
SELECT
  t."createdAt" AS ts,
  t."type"      AS tx_type,
  t."amountGBP" AS amount_gbp,
  la.theme_slug AS theme_slug
FROM live_apps la
JOIN "Transaction" t ON t."applicationId" = la.application_id
WHERE t."type" IN ('paid', 'failed', 'rebill', 'rebill_failed')
ORDER BY t."createdAt" DESC
LIMIT ${Math.max(1, Math.floor(limit))};`.trim();

  const outcome = await runMetabaseSelect(sql);
  if (!outcome.available) return [];

  const items: ActivityItem[] = [];
  for (const r of outcome.rows) {
    const desc = describeTx(String(r["tx_type"]));
    if (!desc) continue;
    const slug = String(r["theme_slug"]);
    const attr = live.map.get(slug) ?? null;
    const amount = toNum(r["amount_gbp"]);
    const amountText = amount > 0 ? ` £${amount.toFixed(2)}` : "";
    const arm = attr?.arm ?? null;
    const armText = arm ?? slug;
    const expSuffix = attr ? ` · ${attr.experimentKey}` : "";
    items.push({
      ts: toIso(r["ts"]),
      kind: desc.kind,
      text: `${desc.phrase}${amountText} on ${armText}${expSuffix}`,
      arm,
      experimentKey: attr?.experimentKey ?? null,
      business: attr?.business ?? null,
    });
  }
  return items;
}

/** Today's collected + auth + rebill for the live slugs. Metabase-less → all 0. */
async function todayTotals(
  live: LiveSlugs,
): Promise<{ collectedGBP: number; auth: number; rebill: number }> {
  const zero = { collectedGBP: 0, auth: 0, rebill: 0 };
  if (live.slugs.length === 0) return zero;
  const slugList = quoteSlugList(live.slugs);
  const since = startOfTodayTimestampLiteral();
  const sql = `
WITH live_apps AS (
  SELECT a."applicationId" AS application_id
  FROM "Application" a
  JOIN "Theme" th ON th."themeId" = a."themeId"
  WHERE th."slug" IN (${slugList})
)
SELECT
  COALESCE(SUM(t."amountGBP") FILTER (WHERE t."type" IN ('paid', 'rebill')), 0) AS collected_gbp,
  COUNT(*) FILTER (WHERE t."type" = 'paid')                                     AS auth_count,
  COUNT(*) FILTER (WHERE t."type" = 'rebill')                                   AS rebill_count
FROM live_apps la
JOIN "Transaction" t ON t."applicationId" = la.application_id
WHERE t."createdAt" >= TIMESTAMP '${since}';`.trim();

  const outcome = await runMetabaseSelect(sql);
  if (!outcome.available) return zero;
  const r = outcome.rows[0];
  if (!r) return zero;
  return {
    collectedGBP: toNum(r["collected_gbp"]),
    auth: toNum(r["auth_count"]),
    rebill: toNum(r["rebill_count"]),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merged, newest-first live feed: assignment events (event store) + recent
 * payment events (Metabase). Degrades on each side independently and never throws.
 */
export async function recentActivity(limit = 20): Promise<ActivityItem[]> {
  const experiments = await safeListExperiments();
  const live = buildLiveSlugs(experiments);

  const [assignRows, payItems] = await Promise.all([
    safe(recentAssignments(limit), [] as StoredEventRow[]),
    recentPayments(live, limit),
  ]);

  const merged = [...assignRows.map(assignmentToItem), ...payItems];
  merged.sort((a, b) => sortKey(b.ts) - sortKey(a.ts));
  return merged.slice(0, limit);
}

/** Today's assignment count + per-business split (event store). Empty → 0 / []. */
export async function assignmentsToday(): Promise<AssignmentsToday> {
  const counts = await safe(assignmentCountsToday(), { total: 0, byBusiness: [] });
  return { total: counts.total, byBusiness: counts.byBusiness };
}

/** Cash collected today (paid + rebill, GBP) across live-experiment slugs. */
export async function collectedTodayGBP(): Promise<number> {
  const live = buildLiveSlugs(await safeListExperiments());
  return (await todayTotals(live)).collectedGBP;
}

/** First-payment successes today across live-experiment slugs. */
export async function authCountToday(): Promise<number> {
  const live = buildLiveSlugs(await safeListExperiments());
  return (await todayTotals(live)).auth;
}

/** Rebill successes today across live-experiment slugs. */
export async function rebillCountToday(): Promise<number> {
  const live = buildLiveSlugs(await safeListExperiments());
  return (await todayTotals(live)).rebill;
}

/**
 * One call that assembles the whole cockpit. Reads experiments once and reuses
 * that snapshot for the live-slug map, the active/queued counts, and the
 * decision-inbox heuristic — so the payment side is exactly two Metabase queries
 * (today totals + recent payments) plus the store reads.
 */
export async function homeMetrics(feedLimit = 20): Promise<HomeMetrics> {
  const experiments = await safeListExperiments();
  const live = buildLiveSlugs(experiments);

  const [totals, assignCounts, assignRows, payItems] = await Promise.all([
    todayTotals(live),
    safe(assignmentCountsToday(), { total: 0, byBusiness: [] }),
    safe(recentAssignments(feedLimit), [] as StoredEventRow[]),
    recentPayments(live, feedLimit),
  ]);

  const feed = [...assignRows.map(assignmentToItem), ...payItems];
  feed.sort((a, b) => sortKey(b.ts) - sortKey(a.ts));

  const activeTests = experiments.filter((e) => e.active).length;
  const queuedTests = experiments.length - activeTests;

  return {
    activeTests,
    queuedTests,
    assignmentsToday: assignCounts.total,
    collectedTodayGBP: totals.collectedGBP,
    authToday: totals.auth,
    rebillToday: totals.rebill,
    awaitingCall: awaitingCallCount(experiments),
    byBusiness: assignCounts.byBusiness,
    feed: feed.slice(0, feedLimit),
  };
}

// ---------------------------------------------------------------------------
// Decision-inbox heuristic — PLACEHOLDER.
// ----------------------------------------------------------------------------
// The real "awaiting a call" number is active experiments whose verdict is
// significant or trips a guardrail. Verdicts are computed from Metabase per
// experiment (lib/verdict.ts over lib/metabase.ts) — an N-query fan-out we don't
// want on every homepage load, and unavailable locally without an API key. Until
// that's wired here, we approximate with a purely local signal: an active
// experiment that has been running at least DECISION_DUE_DAYS days is "likely due
// a call". Clearly labelled so the UI can badge it as an estimate.
// ---------------------------------------------------------------------------

const DECISION_DUE_DAYS = 14;

function awaitingCallCount(experiments: StoredExperiment[]): number {
  const cutoff = Date.now() - DECISION_DUE_DAYS * 86_400_000;
  return experiments.filter((e) => {
    if (!e.active) return false;
    const started = Date.parse(e.startDate);
    return Number.isFinite(started) && started <= cutoff;
  }).length;
}

// ---------------------------------------------------------------------------
// Degrade-gracefully wrappers — turn any rejection into the given fallback so a
// single failing source never takes the page down.
// ---------------------------------------------------------------------------

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

async function safeListExperiments(): Promise<StoredExperiment[]> {
  return safe(listExperiments(), []);
}
