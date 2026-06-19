// The `wasabi` CLI — a thin terminal front-end over the engine's pure core, so
// the team can inspect experiments and dry-run assignments without curl-ing the
// HTTP API. It reuses the SAME functions the server uses (store + assignment +
// api), so what you see here is exactly what a storefront would receive from
// /decide. Transport-free except for the `serve` subcommand, which boots the
// real HTTP server via createServer().
//
// Run (Node 25 runs TS directly via type-stripping):
//   node src/cli.ts experiments
//   node src/cli.ts assign <experimentKey> <distinctId>
//   node src/cli.ts decide <distinctId>
//   node src/cli.ts serve [port]
//   node src/cli.ts help
import { getFeatureFlag } from "./assignment.ts";
import { handleDecide } from "./api.ts";
import { createServer } from "./server.ts";
import { getExperiments, getThemeMap } from "./store.ts";
import type { FeatureFlag } from "./types.ts";

const DEFAULT_PORT = 8787;
const PROG = "wasabi"; // shown in usage/error messages

// ---------------------------------------------------------------------------
// Small output helpers — keep formatting in one place so every command reads
// consistently. No color codes (logs/pipes stay clean); just aligned columns.
// ---------------------------------------------------------------------------

/** Print to stderr — used for usage/errors so stdout stays parseable. */
function err(message: string): void {
  console.error(message);
}

/**
 * Render an array of rows as a left-aligned, space-padded table. Column widths
 * are derived from the header + cell contents so it adapts to any data.
 */
function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => (r[col] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((c, col) => (c ?? "").padEnd(widths[col]!)).join("  ");

  const out = [line(headers), line(widths.map((w) => "-".repeat(w)))];
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/**
 * `experiments` — list every registered experiment: key, active state, each
 * variant with its weight, and the variant→theme slug mapping. This is the
 * "what's running" view, read straight from the store.
 */
function cmdExperiments(): void {
  const experiments = getExperiments();
  if (experiments.length === 0) {
    console.log("No experiments registered.");
    return;
  }

  const rows: string[][] = experiments.map((flag) => {
    const themeMap = getThemeMap(flag.key) ?? {};
    // "control (50%) → tu_lov_uk, variant_19 (50%) → tu_lov_uk_19"
    const variants = (flag.variants ?? [])
      .map((v) => {
        const slug = themeMap[v.key];
        const theme = slug ? ` → ?theme=${slug}` : "";
        return `${v.key} (${v.rolloutPercentage}%)${theme}`;
      })
      .join(", ");
    return [
      flag.key,
      flag.active ? "yes" : "no",
      `${flag.rolloutPercentage}%`,
      variants || "(boolean flag)",
    ];
  });

  console.log(
    renderTable(["KEY", "ACTIVE", "ROLLOUT", "VARIANTS → THEME"], rows),
  );
  console.log(`\n${experiments.length} experiment(s).`);
}

/**
 * `assign <experimentKey> <distinctId>` — resolve ONE experiment for one user:
 * the assigned variant (via getFeatureFlag) and the resulting `?theme=` slug
 * (via the theme map). Errors clearly if the experiment key is unknown.
 *
 * Returns an exit code so the dispatcher can propagate failure to the shell.
 */
function cmdAssign(args: string[]): number {
  const [experimentKey, distinctId] = args;
  if (!experimentKey || !distinctId) {
    err(`usage: ${PROG} assign <experimentKey> <distinctId>`);
    return 2;
  }

  // Look the flag up by key rather than getExperiment() so we can report the
  // full list of valid keys in the not-found message.
  const flag: FeatureFlag | undefined = getExperiments().find(
    (f) => f.key === experimentKey,
  );
  if (!flag) {
    const known = getExperiments()
      .map((f) => f.key)
      .join(", ");
    err(`error: unknown experiment "${experimentKey}".`);
    err(`known experiments: ${known || "(none)"}`);
    return 1;
  }

  const value = getFeatureFlag(flag, distinctId);
  // Only a variant key (string) can carry a theme slug; false/true never do —
  // those route to the storefront's default theme.
  const slug =
    typeof value === "string"
      ? getThemeMap(flag.key)?.[value]
      : undefined;

  console.log(
    renderTable(
      ["FIELD", "VALUE"],
      [
        ["experiment", flag.key],
        ["distinctId", distinctId],
        ["variant", String(value)],
        ["theme", slug ? `?theme=${slug}` : "(default — no theme slug)"],
      ],
    ),
  );
  return 0;
}

/**
 * `decide <distinctId>` — print the FULL handleDecide result for the user:
 * every featureFlag value plus the themes map, i.e. exactly the payload the
 * storefront would receive from POST /decide. JSON, so it can be piped.
 */
function cmdDecide(args: string[]): number {
  const [distinctId] = args;
  if (!distinctId) {
    err(`usage: ${PROG} decide <distinctId>`);
    return 2;
  }

  const result = handleDecide({ distinctId });
  console.log(`/decide for "${distinctId}":\n`);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

/**
 * `serve [port]` — boot the HTTP engine via the shared createServer(). Logs the
 * base URL and the routes the storefront/SDKs can hit. Runs until killed.
 */
function cmdServe(args: string[]): number {
  const [portArg] = args;
  const port = portArg !== undefined ? Number(portArg) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    err(`error: invalid port "${portArg}" (want 1-65535)`);
    return 2;
  }

  createServer().listen(port, () => {
    const base = `http://localhost:${port}`;
    console.log(`wasabi-engine listening on ${base}`);
    console.log("routes:");
    console.log(`  GET  ${base}/health   — liveness probe`);
    console.log(`  GET  ${base}/flags    — list active experiments`);
    console.log(`  POST ${base}/decide   — { distinctId } → flags + themes`);
    console.log(`  POST ${base}/capture  — { distinctId, event, properties? }`);
    console.log("\nCtrl-C to stop.");
  });
  return 0;
}

/** `help` / no args — usage text. */
function printUsage(): void {
  console.log(`${PROG} — Wasabi experimentation engine CLI

usage: ${PROG} <command> [args]

commands:
  experiments                      list every experiment: key, active,
                                   variants + weights, and variant→theme map
  assign <experimentKey> <id>      show the variant + ?theme= slug a user gets
  decide <id>                      print the full /decide payload for a user
                                   (all featureFlags + themes)
  serve [port]                     start the HTTP server (default ${DEFAULT_PORT})
  help                             show this message

examples:
  ${PROG} experiments
  ${PROG} assign tu-billing-uk cust_abc123
  ${PROG} decide cust_abc123
  ${PROG} serve 8787`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Parse argv and route to a subcommand. Returns a process exit code: 0 on
 * success, non-zero on bad usage / unknown command. `serve` returns 0 but keeps
 * the event loop alive (the server holds it open), so we never exit underneath
 * it.
 */
function main(argv: string[]): number {
  // argv[0]=node, argv[1]=script path; the command starts at index 2.
  const [command, ...rest] = argv.slice(2);

  switch (command) {
    case "experiments":
      cmdExperiments();
      return 0;
    case "assign":
      return cmdAssign(rest);
    case "decide":
      return cmdDecide(rest);
    case "serve":
      return cmdServe(rest);
    case "help":
    case "--help":
    case "-h":
    case undefined: // no args → usage, exit 0 (a friendly default)
      printUsage();
      return 0;
    default:
      err(`error: unknown command "${command}"\n`);
      printUsage();
      return 2;
  }
}

// Run-guard: only execute when invoked directly (`node src/cli.ts ...`), not
// when imported. Mirrors server.ts's guard. `serve` deliberately does not exit
// (the server keeps the loop alive); every other command exits with its code.
if (import.meta.url === `file://${process.argv[1]}`) {
  const code = main(process.argv);
  if (process.argv[2] !== "serve") process.exit(code);
}
