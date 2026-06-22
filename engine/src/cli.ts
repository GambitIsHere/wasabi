// The `wasabi` CLI — a thin terminal front-end over the Wasabi service (the
// Next.js dashboard). Every live command reads the SAME source of truth the
// admin UI writes to — the dashboard's SQLite store — by calling its HTTP API,
// so `wasabi experiments` can never drift from what's actually configured (the
// old version read a static in-code fixture and diverged). What you see here is
// exactly what a storefront receives from /api/decide.
//
//   WASABI_URL   base URL of the running dashboard (default http://localhost:3000)
//
// Run (Node 25 runs TS directly via type-stripping):
//   node src/cli.ts experiments
//   node src/cli.ts assign <experimentKey> <distinctId>
//   node src/cli.ts decide <distinctId>
//   node src/cli.ts help
//
// The pure assignment kernel (assignment.ts / hash.ts / types.ts) is unchanged —
// it stays the artifact you vendor into a storefront for local edge-eval; this
// CLI no longer evaluates locally, it asks the canonical service.

const PROG = "wasabi"; // shown in usage/error messages
const BASE = (process.env.WASABI_URL ?? "http://localhost:3000").replace(/\/$/, "");

// ---------------------------------------------------------------------------
// Response shapes (mirror the dashboard's JSON — kept local so the CLI has no
// build dependency on the dashboard package).
// ---------------------------------------------------------------------------

interface StoredVariant {
  key: string;
  rolloutPercentage: number;
  themeSlug: string;
  isControl: boolean;
}
interface StoredExperiment {
  key: string;
  name: string;
  business: string;
  active: boolean;
  goalMetric: string;
  startDate: string;
  rolloutPercentage: number;
  variants: StoredVariant[];
  controlVariant: string;
}
interface DecideResult {
  featureFlags: Record<string, string | boolean>;
  themes: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Output + transport helpers — formatting in one place, and a single fetch
// wrapper that turns "dashboard not running" into a friendly, actionable error.
// ---------------------------------------------------------------------------

/** Print to stderr — used for usage/errors so stdout stays parseable. */
function err(message: string): void {
  console.error(message);
}

/** Thrown for any non-2xx / unreachable service; carries a clean exit code. */
class CliError extends Error {
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

/** GET/POST JSON against the dashboard, with a human error if it's unreachable. */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new CliError(
      `error: could not reach the Wasabi service at ${BASE}.\n` +
        `hint: start the dashboard (npm run dev / the deployed container), ` +
        `or set WASABI_URL to its address.`,
      3,
    );
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* body wasn't JSON — leave detail blank */
    }
    throw new CliError(
      `error: ${BASE}${path} returned ${res.status}${detail ? ` — ${detail}` : ""}`,
      1,
    );
  }
  return (await res.json()) as T;
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
 * `experiments` — list every experiment from the live store: key, active state,
 * each variant with its weight, and the variant→theme slug mapping. This is the
 * "what's running" view, read straight from the dashboard (admin source of truth).
 */
async function cmdExperiments(): Promise<number> {
  const { experiments } = await api<{ experiments: StoredExperiment[] }>(
    "/api/experiments",
  );
  if (experiments.length === 0) {
    console.log("No experiments registered.");
    return 0;
  }

  const rows: string[][] = experiments.map((exp) => {
    // "control (50%) → ?theme=tu_lov_uk, variant_19 (50%) → ?theme=tu_lov_uk_19"
    const variants = exp.variants
      .map(
        (v) =>
          `${v.key} (${v.rolloutPercentage}%) → ?theme=${v.themeSlug}` +
          (v.isControl ? " [control]" : ""),
      )
      .join(", ");
    return [
      exp.key,
      exp.active ? "yes" : "no",
      `${exp.rolloutPercentage}%`,
      variants || "(no variants)",
    ];
  });

  console.log(
    renderTable(["KEY", "ACTIVE", "ROLLOUT", "VARIANTS → THEME"], rows),
  );
  console.log(`\n${experiments.length} experiment(s).`);
  return 0;
}

/**
 * `assign <experimentKey> <distinctId>` — resolve ONE experiment for one user
 * via the service's /api/decide (so the answer is exactly what a storefront
 * gets). Reports the assigned variant and the resulting `?theme=` slug. Errors
 * clearly, listing valid keys, if the experiment is unknown.
 */
async function cmdAssign(args: string[]): Promise<number> {
  const [experimentKey, distinctId] = args;
  if (!experimentKey || !distinctId) {
    err(`usage: ${PROG} assign <experimentKey> <distinctId>`);
    return 2;
  }

  const { featureFlags, themes } = await api<DecideResult>("/api/decide", {
    method: "POST",
    body: JSON.stringify({ distinctId }),
  });

  if (!(experimentKey in featureFlags)) {
    const known = Object.keys(featureFlags).join(", ");
    err(`error: unknown experiment "${experimentKey}".`);
    err(`known experiments: ${known || "(none)"}`);
    return 1;
  }

  const value = featureFlags[experimentKey];
  // Only a variant key (string) carries a theme slug; false (paused / not in
  // test) routes to the storefront's default theme.
  const slug = themes[experimentKey];

  console.log(
    renderTable(
      ["FIELD", "VALUE"],
      [
        ["experiment", experimentKey],
        ["distinctId", distinctId],
        ["variant", String(value)],
        ["theme", slug ? `?theme=${slug}` : "(default — no theme slug)"],
      ],
    ),
  );
  return 0;
}

/**
 * `decide <distinctId>` — print the FULL /api/decide result for the user: every
 * featureFlag value plus the themes map, i.e. exactly the payload the storefront
 * would receive. JSON, so it can be piped.
 */
async function cmdDecide(args: string[]): Promise<number> {
  const [distinctId] = args;
  if (!distinctId) {
    err(`usage: ${PROG} decide <distinctId>`);
    return 2;
  }

  const result = await api<DecideResult>("/api/decide", {
    method: "POST",
    body: JSON.stringify({ distinctId }),
  });
  console.log(`/decide for "${distinctId}":\n`);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

/**
 * `serve` — deprecated. The Wasabi service (the dashboard) IS the HTTP server
 * and serves /api/decide·/capture·/flags from the live store. The old standalone
 * engine server (engine/src/server.ts) reads a static fixture and would diverge,
 * so the CLI no longer boots it. Point things at WASABI_URL instead.
 */
function cmdServe(): number {
  console.log(
    `'${PROG} serve' is deprecated — the Wasabi dashboard already serves the API.\n\n` +
      `The live endpoints are at ${BASE}:\n` +
      `  GET  ${BASE}/api/flags        — active experiments (PostHog shape)\n` +
      `  GET  ${BASE}/api/experiments  — full experiment defs\n` +
      `  POST ${BASE}/api/decide       — { distinctId } → flags + themes\n` +
      `  POST ${BASE}/api/capture      — { distinctId, event, properties? }\n\n` +
      `Run the dashboard with 'npm run dev' (dev) or 'docker compose up' (deploy/).\n` +
      `The standalone engine server (static fixture, offline kernel testing only) ` +
      `still lives at engine/src/server.ts if you really need it.`,
  );
  return 0;
}

/** `help` / no args — usage text for the unified `wasabi` command. */
function printUsage(): void {
  console.log(`${PROG} — Wasabi experimentation engine CLI

usage: ${PROG} <command> [args]

commands:
  experiments                      list every experiment: key, active,
                                   variants + weights, and variant→theme map
  assign <experimentKey> <id>      show the variant + ?theme= slug a user gets
  decide <id>                      print the full /decide payload for a user
                                   (all featureFlags + themes)
  results [experimentKey]          live per-variant P&L verdict (decision-helper)
  help                             show this message

reads from the running dashboard (set WASABI_URL; default ${BASE}).

examples:
  ${PROG} experiments
  ${PROG} assign tu-billing-uk cust_abc123
  ${PROG} decide cust_abc123
  ${PROG} results tu-billing-uk`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Parse argv and route to a subcommand. Returns a process exit code. */
async function main(argv: string[]): Promise<number> {
  // argv[0]=node, argv[1]=script path; the command starts at index 2.
  const [command, ...rest] = argv.slice(2);

  switch (command) {
    case "experiments":
      return cmdExperiments();
    case "assign":
      return cmdAssign(rest);
    case "decide":
      return cmdDecide(rest);
    case "serve":
      return cmdServe();
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
// when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      const code = e instanceof CliError ? e.code : 1;
      err(e instanceof Error ? e.message : String(e));
      process.exit(code);
    });
}
