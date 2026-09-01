// ============================================================================
// Wasabi management layer — data-model contract, shared constants, validation.
// ----------------------------------------------------------------------------
// PURE module: no node:* imports, no I/O. Safe to import from BOTH server code
// (store, actions) and client components (the variants editor), so the form and
// the server validate against exactly the same rules.
//
// The store (lib/store.ts) persists these shapes to SQLite and adapts them to
// the engine's RegisteredExperiment (lib/experiments.ts) so assignment/results
// keep working unchanged.
// ============================================================================

// ---------------------------------------------------------------------------
// Contract (as specified by the management spec)
// ---------------------------------------------------------------------------

export interface VariantInput {
  key: string;
  rolloutPercentage: number;
  themeSlug: string;
  isControl: boolean;
}

export interface ExperimentInput {
  name: string;
  /** Optional on create — slugged from `name` when absent. Immutable on edit. */
  key?: string;
  business: string;
  goalMetric: string;
  startDate: string;
  /** Optional 1-2 sentence rationale shown on the card and detail page. */
  description?: string;
  variants: VariantInput[];
}

export interface StoredExperiment {
  key: string;
  name: string;
  business: string;
  active: boolean;
  goalMetric: string;
  startDate: string;
  /** 1-2 sentence rationale; empty string when the user hasn't filled one in. */
  description: string;
  createdAt: string;
  /** Share of users included in the flag at all — always 100 for managed experiments. */
  rolloutPercentage: number;
  variants: VariantInput[];
  /** The control variant's key. */
  controlVariant: string;
  /** variant key → storefront `?theme=` slug. */
  themeMap: Record<string, string>;
}

export type ActionResult = { ok: true; key: string } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Reference data (single source of truth for the form selects + validation)
// ---------------------------------------------------------------------------

/** The real Sanjow businesses an experiment can belong to. */
export const BUSINESSES = [
  "Top Up",
  "Airport Check-In",
  "Airport Security",
  "PDF SaaS",
  "Global Tickets",
  "Global Visa",
  "Gift Cards",
  "Airport Lounges",
] as const;
export type Business = (typeof BUSINESSES)[number];

/**
 * SUGGESTED storefront `?theme=` slugs — surfaced as autocomplete in the form.
 * This is NOT an exhaustive whitelist: global-api's `Theme` table holds 600+ slugs
 * across all businesses (tu_*, ac_*, as_*, pdf_*, …) and grows whenever a storefront
 * adds a locale or form. Validation is therefore format-based (see THEME_SLUG_RE),
 * not membership here — Wasabi routes an opaque slug; the storefront + the Theme
 * registry stay authoritative. Add common picks here purely to speed up the form.
 */
export const THEME_SLUGS = [
  // Top Up
  "tu_lov_uk",
  "tu_lov_uk_19",
  "tu_lov_uk_39",
  "tu_lov_ie_serenity",
  "tu_lov_ie",
  "tu_default",
  // Airport Check-In
  "ac_mto_lov",
  "ac_mto_lov_24_9",
  // Airport Security (fast-track)
  "as_sub_1m_19",
  "as_sub_lov_1m_14",
  // PDF SaaS
  "pdf_3m",
  "pdf_6m",
  "pdf_auth19",
  "pdf_auth49",
] as const;
export type ThemeSlug = (typeof THEME_SLUGS)[number];

/**
 * A slug is valid if it matches the SHAPE of a Theme.slug (Postgres VarChar(50)):
 * lower-case, starts with a letter, then letters / digits / "_" / "-", ≤ 50 chars.
 * Shape-not-membership means any business's slugs — including ones created after
 * this deploy — pass without a code change. A wrong slug fails safe: its results
 * arm is simply empty and the storefront serves its default theme.
 */
export const THEME_SLUG_RE = /^[a-z][a-z0-9_-]{1,49}$/;

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

/** Lower-kebab slug from arbitrary text: "Top-Up Billing UK!" → "top-up-billing-uk". */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Validation — used by BOTH the client form (live, to gate submit) and the
// server actions (authoritative). Returns a single error string or null.
// ---------------------------------------------------------------------------

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
const VARIANT_KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Sum of variant splits, tolerant of tiny float noise. */
export function splitTotal(variants: readonly VariantInput[]): number {
  return variants.reduce((sum, v) => sum + (Number(v.rolloutPercentage) || 0), 0);
}

/**
 * Validate an ExperimentInput against every business rule:
 *   - name non-empty
 *   - business in the allowed set; goalMetric in `allowedGoalMetrics`
 *   - startDate is YYYY-MM-DD
 *   - ≥2 variants, each with a valid key, a valid theme slug, an integer split
 *   - variant keys unique
 *   - splits sum to EXACTLY 100
 *   - EXACTLY one control
 * `keyForUniqueness` is the resolved key (slug or provided) — validated for shape
 * here; the store layer checks cross-experiment uniqueness against the DB.
 *
 * `allowedGoalMetrics` is a REQUIRED parameter, not a module constant: goal
 * metrics now come from lib/metrics.ts's registry (isGoal=true rows), a DB
 * read this pure/no-I/O module must never make itself. The caller supplies
 * the currently-valid set — the client form gets it via a server-rendered
 * prop (getMetrics() in app/experiments/new|[key]/edit's page.tsx), the
 * server action re-derives it itself (app/actions.ts) so validation stays
 * authoritative rather than trusting whatever the client sent. Pass the
 * EXPERIMENT'S OWN CURRENT goalMetric alongside the registry set when editing
 * (see app/actions.ts's updateExperiment) so an experiment created before a
 * metric was renamed/removed from the registry keeps saving — this function
 * only checks membership, it has no notion of "unchanged from before".
 */
/** Max description length — keeps card layouts predictable; ~400 chars is 3-4 lines. */
export const DESCRIPTION_MAX = 400;

export function validateInput(
  input: ExperimentInput,
  allowedGoalMetrics: readonly string[],
): string | null {
  if (!input.name || input.name.trim().length === 0) {
    return "Name is required.";
  }
  if (input.description !== undefined && input.description.length > DESCRIPTION_MAX) {
    return `Description must be ${DESCRIPTION_MAX} characters or fewer (currently ${input.description.length}).`;
  }
  if (!BUSINESSES.includes(input.business as Business)) {
    return `Business must be one of: ${BUSINESSES.join(", ")}.`;
  }
  if (!allowedGoalMetrics.includes(input.goalMetric)) {
    return `Goal metric must be one of: ${allowedGoalMetrics.join(", ")}.`;
  }
  if (!ISO_DATE_RE.test(input.startDate)) {
    return "Start date must be a valid date (YYYY-MM-DD).";
  }

  const key = (input.key && input.key.trim()) || slugify(input.name);
  if (!KEY_RE.test(key)) {
    return "Key must be lower-case letters, numbers and hyphens (e.g. tu-billing-uk).";
  }

  const variants = input.variants ?? [];
  if (variants.length < 2) {
    return "An experiment needs at least 2 variants.";
  }

  const seenKeys = new Set<string>();
  for (const v of variants) {
    const vKey = (v.key ?? "").trim();
    if (!VARIANT_KEY_RE.test(vKey)) {
      return `Variant key "${v.key}" is invalid — use lower-case letters, numbers, "_" or "-".`;
    }
    if (seenKeys.has(vKey)) {
      return `Duplicate variant key "${vKey}".`;
    }
    seenKeys.add(vKey);

    if (!Number.isInteger(v.rolloutPercentage) || v.rolloutPercentage < 0 || v.rolloutPercentage > 100) {
      return `Variant "${vKey}" split must be a whole number between 0 and 100.`;
    }
    if (!THEME_SLUG_RE.test(v.themeSlug ?? "")) {
      return `Variant "${vKey}" theme slug "${v.themeSlug}" is invalid — lower-case letters, numbers, "_" or "-", max 50 chars (e.g. tu_lov_uk_19, as_sub_1m_19, pdf_auth19).`;
    }
  }

  const total = splitTotal(variants);
  if (total !== 100) {
    return `Variant splits must sum to exactly 100% (currently ${total}%).`;
  }

  const controls = variants.filter((v) => v.isControl);
  if (controls.length !== 1) {
    return controls.length === 0
      ? "Exactly one variant must be marked as the control."
      : `Exactly one control allowed — ${controls.length} are marked.`;
  }

  return null;
}
