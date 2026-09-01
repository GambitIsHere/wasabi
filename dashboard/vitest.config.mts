// ============================================================================
// Vitest config — pure-function unit tests only.
// ----------------------------------------------------------------------------
// Wasabi's test suite covers the engine math (hash/assignment), the verdict
// stats, and the mgmt/backlog validators — all plain TypeScript with no DOM.
// So: `environment: "node"` (no jsdom) and no React Testing Library. If a
// component test is ever added, give IT an explicit jsdom environment via a
// `// @vitest-environment jsdom` docblock rather than flipping this default —
// jsdom is heavier and most of this codebase doesn't need it.
//
// The `@/*` alias mirrors tsconfig.json's `paths` (`"@/*": ["./*"]`) so tests
// can import source the same way the app does (e.g. `@/lib/verdict`) instead
// of fragile relative paths.
// ============================================================================
import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "."),
    },
  },
});
