// The HTTP transport — a thin `node:http` shell over the pure handlers in
// api.ts. Its only jobs: read the body, parse JSON, route by method+path, set
// permissive CORS (storefronts call us cross-origin from many domains), and
// serialise the typed response. All experiment logic lives in api.ts.
import http from "node:http";
import { handleCapture, handleDecide, handleFlags } from "./api.ts";
import type { CaptureRequest, DecideRequest } from "./wire.ts";

const DEFAULT_PORT = 8787;

// CORS: storefronts on arbitrary origins POST here from the browser, so we
// reflect a wildcard. No credentials/cookies are involved (assignment is keyed
// by distinctId in the body), so `*` is safe and simplest.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** Write a JSON response with CORS headers and the given status. */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...CORS_HEADERS,
  });
  res.end(payload);
}

/** Read the full request body and parse it as JSON. Rejects on malformed JSON. */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  // Collect chunks; bodies here are tiny (one distinctId + a few props).
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (raw.trim() === "") return {};
  return JSON.parse(raw); // throws SyntaxError on bad JSON → caught as 400
}

/**
 * Build the engine's HTTP server. Does NOT call `listen()` — the caller (the
 * run-guard below, or a test/demo) decides the port and lifecycle.
 */
export function createServer(): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res);
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  // Path only — strip any query string; we route on the pathname alone.
  const path = (req.url ?? "/").split("?")[0];

  // CORS preflight: answer every OPTIONS with the headers and no body.
  if (method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Health check — cheap liveness probe, no body parsing.
  if (method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /flags — list active experiments.
  if (method === "GET" && path === "/flags") {
    sendJson(res, 200, handleFlags());
    return;
  }

  // POST /decide and POST /capture both take a JSON body.
  if (method === "POST" && (path === "/decide" || path === "/capture")) {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    if (path === "/decide") {
      sendJson(res, 200, handleDecide(body as DecideRequest));
    } else {
      sendJson(res, 200, handleCapture(body as CaptureRequest));
    }
    return;
  }

  // Anything else.
  sendJson(res, 404, { error: "not found" });
}

// Run-guard: when this file is executed directly (`node src/server.ts`) start
// listening; when it's imported (by the demo/tests) do nothing. `import.meta`
// has the entry-point URL only for the directly-run module.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  createServer().listen(port, () => {
    console.log(`wasabi-engine listening on http://localhost:${port}`);
  });
}
