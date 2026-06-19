// ============================================================================
// Wasabi decision-helper — RUN (live)
// ----------------------------------------------------------------------------
// Runs the validated per-variant results query LIVE against the global-api
// Postgres (Metabase "MAIN DB - Production"), via sanjow-analytics/mb-query.sh
// (which resolves a READ-ONLY key from ~/.zshrc and refuses non-SELECT). Parses
// the {cols,rows} JSON, builds the per-variant rows, calls buildVerdict, and
// pretty-prints: the per-variant table, the significance tests, and the
// narrative + recommendation.
//
// Run:  node decision-helper/run.ts          (Node 25 runs TS directly)
//
// Configured for experiment "tu-billing-uk":
//   control     → tu_lov_uk      (the baseline)
//   variant_19  → tu_lov_uk_19   (£19 plan)
//   variant_39  → tu_lov_uk_39   (£39 plan)
//   start:        2026-05-07
// ============================================================================

import { execFileSync } from "node:child_process";
import { buildVerdict } from "./verdict.ts";
import type { VariantRow, Verdict, SignificanceTest } from "./verdict.ts";

// ---------------------------------------------------------------------------
// Experiment config — the variant→slug map + start date (edit per experiment)
// ---------------------------------------------------------------------------

const MB_QUERY = "/Users/srikan/Sanjow-Ventures/sanjow-analytics/scripts/mb-query.sh";

const EXPERIMENT = {
  key: "tu-billing-uk",
  start: "2026-05-07",
  controlSlug: "tu_lov_uk",
  /** variant key → theme slug. Order = display order. */
  variants: [
    { variant: "control", themeSlug: "tu_lov_uk" },
    { variant: "variant_19", themeSlug: "tu_lov_uk_19" },
    { variant: "variant_39", themeSlug: "tu_lov_uk_39" },
  ] as const,
};

// ---------------------------------------------------------------------------
// The results query (from results.sql — generalized template). We add the
// raw first_failed count so the auth-rate denominator is exact rather than
// reconstructed from the rounded percentage.
// ---------------------------------------------------------------------------

function resultsSql(slugs: readonly string[], start: string): string {
  const slugList = slugs.map((s) => `'${s}'`).join(", ");
  return `
WITH variant AS (
  SELECT
    th."slug"          AS theme_slug,
    a."applicationId"  AS application_id
  FROM "Application" a
  JOIN "Theme" th ON th."themeId" = a."themeId"
  WHERE th."slug" IN (${slugList})
    AND a."createdAt" >= TIMESTAMP '${start}'
),
tx AS (
  SELECT
    v.theme_slug,
    v.application_id,
    t."type"      AS tx_type,
    t."amountGBP" AS amount_gbp
  FROM variant v
  LEFT JOIN "Transaction" t ON t."applicationId" = v.application_id
)
SELECT
  theme_slug,
  COUNT(DISTINCT application_id)                                          AS apps_acquired,
  COUNT(*) FILTER (WHERE tx_type = 'paid')                               AS first_paid,
  COUNT(*) FILTER (WHERE tx_type = 'failed')                             AS first_failed,
  ROUND(100.0 * COUNT(*) FILTER (WHERE tx_type = 'paid')
    / NULLIF(COUNT(*) FILTER (WHERE tx_type IN ('paid','failed')), 0), 1) AS auth_rate,
  COUNT(*) FILTER (WHERE tx_type = 'rebill')                             AS rebill_ok,
  COUNT(*) FILTER (WHERE tx_type = 'rebill_failed')                      AS rebill_fail,
  ROUND(100.0 * COUNT(*) FILTER (WHERE tx_type = 'rebill')
    / NULLIF(COUNT(*) FILTER (WHERE tx_type IN ('rebill','rebill_failed')), 0), 1) AS rebill_rate,
  ROUND(SUM(amount_gbp) FILTER (WHERE tx_type IN ('paid','rebill')), 2)  AS revenue_gbp,
  ROUND(SUM(amount_gbp) FILTER (WHERE tx_type IN ('paid','rebill'))
    / NULLIF(COUNT(DISTINCT application_id), 0), 2)                      AS rev_per_acquired
FROM tx
GROUP BY theme_slug
ORDER BY theme_slug;`.trim();
}

// ---------------------------------------------------------------------------
// Live query runner — shells out to mb-query.sh (read-only, refuses mutations)
// ---------------------------------------------------------------------------

/** A column-name-keyed view of one DB row. */
type RawRow = Record<string, unknown>;

/** Run a SELECT/WITH query via mb-query.sh and return rows as objects. */
function runQuery(sql: string): RawRow[] {
  // mb-query.sh reads SQL from stdin when its arg is "-". execFileSync (not
  // exec) avoids a shell entirely, so the SQL can't be re-interpreted by /bin/sh.
  const out = execFileSync("bash", [MB_QUERY, "-"], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  const parsed = JSON.parse(out) as { cols: string[]; rows: unknown[][] };
  const { cols, rows } = parsed;
  // Zip each value array against the column names into a keyed object.
  return rows.map((row) => {
    const obj: RawRow = {};
    cols.forEach((c, i) => {
      obj[c] = row[i];
    });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Map DB rows → typed VariantRow[] in the configured variant order
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  // Metabase returns numbers, but SUM/ROUND can surface as strings or null.
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toVariantRows(raw: RawRow[]): VariantRow[] {
  // Index DB rows by their theme slug so we can line them up with the config.
  const bySlug = new Map<string, RawRow>();
  for (const r of raw) bySlug.set(String(r["theme_slug"]), r);

  return EXPERIMENT.variants.map(({ variant, themeSlug }) => {
    const r = bySlug.get(themeSlug);
    if (!r) {
      throw new Error(
        `No DB row for theme_slug "${themeSlug}" (variant "${variant}"). ` +
        `Got slugs: ${[...bySlug.keys()].join(", ") || "(none)"}.`,
      );
    }
    return {
      variant,
      themeSlug,
      isControl: themeSlug === EXPERIMENT.controlSlug,
      appsAcquired: num(r["apps_acquired"]),
      firstPaid: num(r["first_paid"]),
      firstFailed: num(r["first_failed"]),
      authRate: num(r["auth_rate"]),
      rebillOk: num(r["rebill_ok"]),
      rebillFail: num(r["rebill_fail"]),
      rebillRate: num(r["rebill_rate"]),
      revenueGbp: num(r["revenue_gbp"]),
      revPerAcquired: num(r["rev_per_acquired"]),
    };
  });
}

// ---------------------------------------------------------------------------
// Pretty-printing
// ---------------------------------------------------------------------------

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

/** Right/left-pad a cell to a fixed width. */
function cell(s: string | number, width: number, align: "l" | "r" = "r"): string {
  const str = String(s);
  if (str.length >= width) return str;
  const pad = " ".repeat(width - str.length);
  return align === "r" ? pad + str : str + pad;
}

function printVariantTable(rows: VariantRow[]): void {
  console.log(`\n${BOLD}PER-VARIANT P&L${RESET}  ${DIM}(cohort-clean, collected-to-date)${RESET}`);
  const head =
    cell("variant", 12, "l") + cell("slug", 15, "l") + cell("apps", 8) + cell("paid", 7) +
    cell("auth%", 8) + cell("reb_ok", 8) + cell("reb_fail", 9) + cell("rebill%", 9) +
    cell("revenue£", 13) + cell("rev/acq£", 10);
  console.log(DIM + head + RESET);
  console.log(DIM + "-".repeat(head.length) + RESET);
  for (const r of rows) {
    const tag = r.isControl ? `${DIM}(ctrl)${RESET}` : "";
    console.log(
      cell(r.variant, 12, "l") +
      cell(r.themeSlug, 15, "l") +
      cell(r.appsAcquired.toLocaleString(), 8) +
      cell(r.firstPaid.toLocaleString(), 7) +
      cell(r.authRate.toFixed(1), 8) +
      cell(r.rebillOk.toLocaleString(), 8) +
      cell(r.rebillFail.toLocaleString(), 9) +
      cell(r.rebillRate.toFixed(1), 9) +
      cell(r.revenueGbp.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), 13) +
      cell(r.revPerAcquired.toFixed(2), 10) +
      " " + tag,
    );
  }
}

function sigColor(t: SignificanceTest): string {
  if (!t.significant) return DIM;
  return t.deltaPp >= 0 ? GREEN : RED;
}

function printSignificance(sig: SignificanceTest[]): void {
  console.log(`\n${BOLD}SIGNIFICANCE vs CONTROL${RESET}  ${DIM}(two-proportion z-test, two-tailed)${RESET}`);
  const head =
    cell("metric · variant", 26, "l") + cell("control", 9) + cell("variant", 9) +
    cell("Δpp", 8) + cell("Δrel", 8) + cell("z", 8) + cell("p", 10) + "  verdict";
  console.log(DIM + head + RESET);
  console.log(DIM + "-".repeat(head.length + 18) + RESET);
  for (const t of sig) {
    const c = sigColor(t);
    const deltaPp = `${t.deltaPp >= 0 ? "+" : ""}${t.deltaPp.toFixed(1)}`;
    const deltaRel = `${t.deltaRel >= 0 ? "+" : ""}${(t.deltaRel * 100).toFixed(0)}%`;
    console.log(
      cell(t.metric, 26, "l") +
      cell((t.controlRate * 100).toFixed(1) + "%", 9) +
      cell((t.variantRate * 100).toFixed(1) + "%", 9) +
      c + cell(deltaPp, 8) + RESET +
      cell(deltaRel, 8) +
      cell(t.z.toFixed(2), 8) +
      cell(t.p < 0.0001 ? "<0.0001" : t.p.toFixed(4), 10) +
      "  " + c + t.label + RESET,
    );
  }
}

function printWinners(verdict: Verdict): void {
  console.log(`\n${BOLD}WINNER BY METRIC${RESET}`);
  for (const w of verdict.winners) {
    const isControlWin = w.winner === verdict.controlVariant;
    const unit = w.metric === "rev_per_acquired" ? "£" : "%";
    const fmt = (n: number) => (unit === "£" ? `£${n.toFixed(2)}` : `${n.toFixed(1)}%`);
    const deltaStr = isControlWin
      ? `${DIM}(control holds)${RESET}`
      : `${GREEN}${w.delta >= 0 ? "+" : ""}${unit === "£" ? "£" + w.delta.toFixed(2) : w.delta.toFixed(1) + "pp"} ` +
        `(${w.deltaRel >= 0 ? "+" : ""}${(w.deltaRel * 100).toFixed(0)}%) vs control${RESET}`;
    console.log(
      `  ${cell(w.metric, 18, "l")} → ${BOLD}${w.winner}${RESET} ` +
      `${fmt(w.winnerValue)} ${DIM}(control ${fmt(w.controlValue)})${RESET}  ${deltaStr}`,
    );
  }
}

function printNarrative(verdict: Verdict): void {
  const recColor =
    verdict.recommendation === "ship" ? GREEN :
    verdict.recommendation === "keep_running" ? YELLOW : DIM;
  console.log(`\n${BOLD}VERDICT${RESET}  ${recColor}[${verdict.recommendation.toUpperCase().replace("_", " ")}]${RESET}\n`);
  // Wrap each paragraph at ~96 cols for terminal readability.
  for (const para of verdict.narrative.split("\n\n")) {
    console.log(wrap(para, 96));
    console.log("");
  }
}

/** Naive greedy word-wrap. */
function wrap(text: string, width: number): string {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      out.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) out.push(line);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(): void {
  console.log(`\n${BOLD}═══ Wasabi decision-helper · experiment "${EXPERIMENT.key}" ═══${RESET}`);
  console.log(`${DIM}control=${EXPERIMENT.controlSlug} · start=${EXPERIMENT.start} · live read-only DB${RESET}`);

  const slugs = EXPERIMENT.variants.map((v) => v.themeSlug);
  const sql = resultsSql(slugs, EXPERIMENT.start);

  console.log(`${DIM}Querying global-api Postgres via mb-query.sh …${RESET}`);
  const raw = runQuery(sql);
  const rows = toVariantRows(raw);

  printVariantTable(rows);

  const verdict = buildVerdict(rows);
  printSignificance(verdict.significance);
  printWinners(verdict);
  printNarrative(verdict);
}

main();
