// Minimal Node module-resolution hook: lets extensionless relative imports
// (e.g. `./db`, `../experiments`) resolve to their `.ts` files, so we can run
// the real TypeScript store source under `node --experimental-strip-types`
// without a bundler or any npm transpiler. Test-only.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
    try {
      const base = new URL(specifier + ".ts", context.parentURL);
      if (existsSync(fileURLToPath(base))) {
        return nextResolve(specifier + ".ts", context);
      }
    } catch {
      // fall through to default resolution
    }
  }
  return nextResolve(specifier, context);
}
