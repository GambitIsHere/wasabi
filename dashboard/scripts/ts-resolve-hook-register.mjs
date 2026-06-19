// Registers the extensionless-`.ts` resolution hook for the current process.
// Used via `node --import ./scripts/ts-resolve-hook-register.mjs ...`.
import { register } from "node:module";
register("./ts-resolve-hook.mjs", import.meta.url);
