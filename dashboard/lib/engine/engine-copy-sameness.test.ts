// ============================================================================
// A6 — engine copy sameness guard.
// ----------------------------------------------------------------------------
// engine/src/{assignment,hash,types,wire}.ts and dashboard/lib/engine/{same}
// are meant to be the SAME code, vendored twice: storefronts import the
// engine/src copy directly for local-eval assignment (see
// integration/nextjs-middleware.example.ts), while the dashboard imports its
// own copy for /api/decide. If the two silently drift, a storefront can
// assign a visitor to a different variant than /api/decide would for the
// exact same distinctId — a correctness bug with no compiler or runtime
// signal, since both copies type-check and run fine on their own.
//
// The ONLY sanctioned difference is import-specifier extensions: engine/src
// (plain Node/tsx ESM resolution) writes `from "./hash.ts"`; dashboard
// (Next.js's bundler resolution) writes `from "./hash"`. This test strips
// that one difference and then requires the sources to be byte-identical —
// so any REAL edit to either copy that isn't mirrored to the other fails
// here, in CI, before it ships.
// ============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dashboardEngineDir = path.dirname(fileURLToPath(import.meta.url));
const engineSrcDir = path.resolve(dashboardEngineDir, "../../../engine/src");

const FILES = ["assignment.ts", "hash.ts", "types.ts", "wire.ts"] as const;

/**
 * Strip a trailing ".ts" off relative import/export specifiers only
 * (`from "./hash.ts"` → `from "./hash"`, `from "../x/y.ts"` → `from "../x/y"`).
 * Deliberately narrow — only touches `(import|export) ... from "<relative>.ts"`
 * — so it can't accidentally mask a real divergence elsewhere in the file.
 */
function normaliseImportExtensions(source: string): string {
  return source.replace(/(from\s+["'])(\.[^"']+?)\.ts(["'])/g, "$1$2$3");
}

describe("engine copy sameness — dashboard/lib/engine vs engine/src", () => {
  it.each(FILES)(
    "%s is identical in both copies (import-extension convention aside)",
    (file) => {
      const dashboardSrc = normaliseImportExtensions(
        readFileSync(path.join(dashboardEngineDir, file), "utf8"),
      );
      const engineSrc = normaliseImportExtensions(
        readFileSync(path.join(engineSrcDir, file), "utf8"),
      );

      expect(
        dashboardSrc,
        `\n\ndashboard/lib/engine/${file} and engine/src/${file} have DIVERGED beyond the ` +
          `sanctioned ".ts" import-extension difference.\n\n` +
          `These two files are supposed to be the SAME engine code, vendored twice — storefronts ` +
          `import engine/src directly for local-eval assignment, while the dashboard imports its ` +
          `own copy for /api/decide. If they drift, a storefront can assign a visitor to a ` +
          `different variant than /api/decide would for the exact same distinctId.\n\n` +
          `Fix: port whichever side you just changed onto the OTHER copy (dashboard/lib/engine/${file} ` +
          `<-> engine/src/${file}) so both read the same again — keep engine/src's "./x.ts" import ` +
          `style and dashboard's "./x" style, that's the one allowed difference — then rerun this test.`,
      ).toBe(engineSrc);
    },
  );
});
