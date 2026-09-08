// ============================================================================
// Variant-readiness — is a suggested experiment arm already BUILT in its
// storefront, or does it need a build ticket? (server-only; the pure parts are
// fs-free and unit-tested directly.)
// ----------------------------------------------------------------------------
// When the roadmap promotes a backlog ticket into an experiment, each arm routes
// to a storefront theme slug (or a &var= value). Before anyone files a "build
// this variant" ticket, the loop asks: does the storefront ALREADY understand
// this arm? Three answers, cheapest signal first:
//
//   BUILT      — a literal hit: the exact slug string appears in the storefront
//                repo's source (a coded theme, or a &var= value the page reads).
//   BUILT      — data-only arm: no literal hit, but EVERY segment of the slug is
//                one the tool recognises (a known business prefix, a segment seen
//                in a known-good theme slug, a locale/market code, or a numeric
//                price token). Such a slug just recombines tokens the storefront
//                already parses at runtime — no code change needed.
//   NOT-BUILT  — a novel segment: something in the slug is unfamiliar, so a human
//                has to build it. This is the only state that offers a build
//                ticket.
//   UNKNOWN    — the storefront checkout isn't on disk (the prod runtime, or a
//                business with no mapped repo). Never guess, never auto-create.
//
// SAFE BIAS: the data-only tier is deliberately conservative — an unrecognised
// segment yields NOT-BUILT, not BUILT. A false NOT-BUILT merely OFFERS a build
// ticket an admin can decline; a false BUILT would SILENTLY skip a real gap. So
// we only ever call an arm "built (data-only)" when every segment is known.
//
// SERVER-ONLY for checkVariantReadiness (reads the filesystem). The pure helpers
// (resolveStorefrontRepo, segmentsRecognized) are dependency-free.
// ============================================================================
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LANE_META, type Lane } from "./roadmap";
import { THEME_SLUGS, THEME_SLUG_RE } from "./mgmt";

export type ReadinessState = "built" | "not-built" | "unknown";

export interface ReadinessResult {
  state: ReadinessState;
  /** Plain-English explanation for the UI. */
  reason: string;
  slug: string;
  business: string;
  /** The storefront repo checked (when one was mapped). */
  repo?: string;
  /** Repo-relative path of the literal hit, when state === "built" via grep. */
  matchedFile?: string;
}

// ---------------------------------------------------------------------------
// business → storefront repo (inverted from the roadmap's LANE_META, so the two
// never drift). Only the four lane businesses have a storefront; anything else
// (Global Tickets, Global Visa, …) has no checkout to scan → "unknown".
// ---------------------------------------------------------------------------
const BUSINESS_TO_REPO: Record<string, string> = Object.fromEntries(
  (Object.keys(LANE_META) as Lane[]).map((lane) => [
    LANE_META[lane].business,
    LANE_META[lane].repo,
  ]),
);

/** The storefront repo folder name for a business label, or null when none. */
export function resolveStorefrontRepo(business: string): string | null {
  return BUSINESS_TO_REPO[business] ?? null;
}

// ---------------------------------------------------------------------------
// Recognised-segment vocabulary — grounded in real data, not invented.
//   * every segment that appears in a known-good theme slug (mgmt.THEME_SLUGS),
//   * the business prefixes the backlog already parses (lib/backlog.ts) plus the
//     storefront brand markers (lov/fly/pmr/at families),
//   * locale + market codes the storefront theme-resolvers recognise,
//   * a numeric price token (pure digits, or digits + a single unit letter like
//     1m / 3m / 6m).
// A slug whose every segment is in this set is a pure recombination of known
// tokens → data-only. Anything else is a real build.
// ---------------------------------------------------------------------------
const KNOWN_THEME_SEGMENTS = new Set<string>(
  THEME_SLUGS.flatMap((slug) => slug.split("_")),
);

const BUSINESS_PREFIXES = new Set<string>([
  "tu", "tum", "ac", "as", "pdf", "rl", "rlw", "gt", "gc", "al", "ov",
  // storefront brand markers seen in the theme-resolvers
  "fly", "pmr", "at",
]);

const LOCALE_AND_MARKET = new Set<string>([
  // supported locales (the storefront i18n sets)
  "en", "fr", "nl", "de", "es", "it", "ro", "pl", "el", "pt",
  // market codes that resolve to a locale
  "uk", "ie", "us", "cy", "gr",
]);

/** A numeric price/tier token: pure digits (19, 39, 24, 9) or digits + one unit
 *  letter (1m, 3m, 6m). These are data (a price point), never code. */
function isNumericToken(seg: string): boolean {
  return /^\d+$/.test(seg) || /^\d+[a-z]$/.test(seg);
}

/** True when a single slug segment is one the tool already recognises. */
export function segmentRecognized(seg: string): boolean {
  return (
    KNOWN_THEME_SEGMENTS.has(seg) ||
    BUSINESS_PREFIXES.has(seg) ||
    LOCALE_AND_MARKET.has(seg) ||
    isNumericToken(seg)
  );
}

/**
 * True when EVERY segment of a slug is recognised — i.e. the arm is a pure
 * recombination of known tokens and needs no new storefront code (a "data-only"
 * arm). A malformed slug (fails THEME_SLUG_RE) or one with any unknown segment
 * is not data-only.
 */
export function segmentsRecognized(slug: string): boolean {
  if (!THEME_SLUG_RE.test(slug)) return false;
  const segments = slug.split(/[_-]/).filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  return segments.every(segmentRecognized);
}

// ---------------------------------------------------------------------------
// The filesystem grep — bounded and cached.
// ---------------------------------------------------------------------------

/** Repo root that holds the storefront checkouts. Absent in prod → "unknown". */
function storefrontsRoot(): string {
  return process.env.STOREFRONTS_ROOT || "/Users/srikan/Sanjow-Ventures";
}

const SKIP_DIRS = new Set<string>([
  "node_modules", ".next", ".git", "dist", "build", "out", "coverage",
  ".turbo", ".vercel", "ds-bundle", ".cache",
]);
const SCAN_EXTENSIONS = new Set<string>([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".html",
]);
const MAX_FILE_BYTES = 512 * 1024; // skip anything larger — data blobs, not code
const MAX_FILES = 20_000; // hard ceiling so a scan can never run away

function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** First repo-relative path whose text contains `needle`, or null. Bounded. */
function grepRepo(repoDir: string, needle: string): string | null {
  let scanned = 0;
  const stack: string[] = [repoDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          stack.push(full);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf(".");
      const ext = dot >= 0 ? entry.name.slice(dot) : "";
      if (!SCAN_EXTENSIONS.has(ext)) continue;
      if (scanned >= MAX_FILES) return null;
      scanned += 1;
      try {
        const stat = statSync(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        const text = readFileSync(full, "utf8");
        if (text.includes(needle)) {
          return full.slice(repoDir.length + 1);
        }
      } catch {
        // unreadable file — skip
      }
    }
  }
  return null;
}

// 5-minute in-memory cache keyed by repo+slug (the storefront tree changes
// rarely relative to how often the UI re-checks).
const cache = new Map<string, { at: number; result: ReadinessResult }>();
const TTL_MS = 5 * 60_000;

/**
 * Decide whether the arm `slug` (for `business`) is already built in its
 * storefront. Read-only: it never writes, never creates a repo, never files a
 * ticket. Returns "unknown" whenever the storefront checkout isn't on disk.
 */
export function checkVariantReadiness(
  business: string,
  slug: string,
): ReadinessResult {
  const base: Pick<ReadinessResult, "slug" | "business"> = { slug, business };

  if (!THEME_SLUG_RE.test(slug)) {
    return {
      ...base,
      state: "not-built",
      reason: `"${slug}" is not a valid theme slug — an arm needs a real slug before it can be built.`,
    };
  }

  const repo = resolveStorefrontRepo(business);
  if (!repo) {
    return {
      ...base,
      state: "unknown",
      reason: `No storefront repo is mapped for "${business}", so readiness can't be checked.`,
    };
  }

  const repoDir = join(storefrontsRoot(), repo);
  if (!dirExists(repoDir)) {
    return {
      ...base,
      state: "unknown",
      repo,
      reason: `Storefront checkout "${repo}" isn't on disk (expected under STOREFRONTS_ROOT) — readiness can't be checked here.`,
    };
  }

  const cacheKey = `${repo}::${slug}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;

  let result: ReadinessResult;
  const matchedFile = grepRepo(repoDir, slug);
  if (matchedFile) {
    result = {
      ...base,
      state: "built",
      repo,
      matchedFile,
      reason: `Already built — "${slug}" appears in ${repo}/${matchedFile}.`,
    };
  } else if (segmentsRecognized(slug)) {
    result = {
      ...base,
      state: "built",
      repo,
      reason: `Data-only arm — every segment of "${slug}" is a token ${repo} already parses, so no new code is needed.`,
    };
  } else {
    result = {
      ...base,
      state: "not-built",
      repo,
      reason: `Not built — "${slug}" has a segment ${repo} doesn't recognise, so the arm needs building.`,
    };
  }

  cache.set(cacheKey, { at: Date.now(), result });
  return result;
}
