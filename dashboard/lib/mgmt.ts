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
  /**
   * Optional YouTrack ticket this experiment tracks — a bare issue ID (GP-603)
   * or a full pasted issue URL. Empty/undefined when none. Rendered on the
   * detail page as a "Ticket ↗" link (see youtrackTicketHref).
   */
  youtrackTicket?: string;
  /**
   * Initial launch state — CREATE ONLY. `false` = start paused/queued (the
   * management-UI default, so a test can be wired + A/A-checked before it takes
   * real traffic); `true` = start active. Omitted on edit: the active flag is
   * owned there by ExperimentControls, and the update path never reads this.
   * The store treats `undefined` as active (1) so seeding stays unchanged.
   */
  active?: boolean;
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
  /** YouTrack ticket reference (bare ID or full URL); empty string when none. */
  youtrackTicket: string;
}

export type ActionResult = { ok: true; key: string } | { ok: false; error: string };

/**
 * The outcome of a bulk operation over several experiment keys. Partial-failure
 * by design (see lib/store.ts's bulkSetActive/bulkDelete): every key is tried,
 * `changed` lists the keys a row was actually written for, `failed` pairs each
 * remaining key with why (missing / another tenant's / a DB error, or the
 * editor-gate error when the whole call was denied). Lives here — the pure,
 * client-safe contract module — so the store, the server actions AND the client
 * table can all name the same shape without importing server-only code.
 */
export interface BulkActionResult {
  changed: string[];
  failed: { key: string; error: string }[];
}

// ---------------------------------------------------------------------------
// Reference data (single source of truth for the form selects + validation)
// ---------------------------------------------------------------------------

/**
 * The real Sanjow businesses an experiment can belong to. Each carries a short
 * uppercase `code` aligned to the YouTrack project codes — the Business <select>
 * shows the full `label`, while the composed experiment name uses the `code`
 * (see composeExperimentName + businessCode).
 */
export const BUSINESSES = [
  { label: "Top Up", code: "TU" },
  { label: "Airport Check-In", code: "AC" },
  { label: "Airport Security", code: "AS" },
  { label: "PDF SaaS", code: "PDF" },
  { label: "Global Tickets", code: "GT" },
  { label: "Global Visa", code: "GV" },
  { label: "Gift Cards", code: "GC" },
  { label: "Airport Lounges", code: "AL" },
] as const;
/** A business's full display label — the stored `business` value. */
export type Business = (typeof BUSINESSES)[number]["label"];
/** A business's short uppercase code (TU, PDF, AC…). */
export type BusinessCode = (typeof BUSINESSES)[number]["code"];

/** The short uppercase CODE for a business label (TU, PDF, AC…). Falls back to
 *  the label itself for an unknown value (a stale/hand-edited business) so the
 *  composed name degrades gracefully rather than dropping the segment. */
export function businessCode(label: string): string {
  return BUSINESSES.find((b) => b.label === label)?.code ?? label;
}

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

/** The separator the name schema joins its parts with. A spaced pipe, so the
 *  composed name reads as four labelled segments (EXP001 | TU | … | …). */
export const NAME_PART_SEPARATOR = " | ";

/**
 * Compose an experiment name from its 4-part schema —
 * `[unique ID] | [business code] | [what the test is] | [which page]` —
 * skipping any blank part so a half-filled form still produces a clean name.
 * Pure so the form and its tests share one definition of "what the name looks
 * like"; the form keeps this EDITABLE (auto-fill, not a hard lock). The caller
 * passes the business CODE (see businessCode), not the full label, for the
 * business segment.
 */
export function composeExperimentName(parts: {
  uniqueId?: string;
  business?: string;
  what?: string;
  page?: string;
}): string {
  return [parts.uniqueId, parts.business, parts.what, parts.page]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(NAME_PART_SEPARATOR);
}

/** The running experiment counter's prefix and zero-pad width — EXP001, EXP002… */
export const EXP_ID_PREFIX = "EXP";
const EXP_ID_WIDTH = 3;
const EXP_ID_RE = /EXP(\d+)/i;

/**
 * The next free experiment ID given every existing experiment/archive key AND
 * name: scans each string for `EXP<n>` (case-insensitive), takes the max, and
 * returns `EXP` + the zero-padded 3-digit successor. A single running counter
 * across ALL experiments, floored at EXP001 when nothing matches. Pure so the
 * server component can feed it the DB strings and the tests can pin the logic.
 */
export function nextExpId(existing: readonly string[]): string {
  let max = 0;
  for (const s of existing) {
    const m = (s ?? "").match(EXP_ID_RE);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${EXP_ID_PREFIX}${String(max + 1).padStart(EXP_ID_WIDTH, "0")}`;
}

/** A bare YouTrack ticket id, e.g. GP-603, GAPI-12 — one or more uppercase
 *  letters, a hyphen, then digits. */
export const YOUTRACK_TICKET_RE = /^[A-Z]+-\d+$/;

/** True when `value` is an acceptable YouTrack ticket reference: a bare ID
 *  (GP-603) or a full http(s) URL (a pasted issue link). Blank is NOT valid
 *  here — the field is optional, so callers skip this check when it's empty. */
export function isValidYoutrackTicket(value: string): boolean {
  const v = value.trim();
  if (YOUTRACK_TICKET_RE.test(v)) return true;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The link target for a stored YouTrack ticket reference. A full http(s) URL is
 * used as-is; a bare ID becomes `${baseUrl}/issue/${id}`. Returns null for a
 * blank value so callers omit the link entirely (degrade gracefully when
 * absent). `baseUrl` is supplied by the server (env YOUTRACK_BASE_URL) so this
 * stays pure and client-safe.
 */
export function youtrackTicketHref(ticket: string, baseUrl: string): string | null {
  const v = (ticket ?? "").trim();
  if (v.length === 0) return null;
  if (/^https?:\/\//i.test(v)) return v;
  return `${baseUrl.replace(/\/+$/, "")}/issue/${v}`;
}

/**
 * The key for a NEW experiment: the slug of the Unique ID when it yields a
 * valid slug (e.g. "GP-603" → "gp-603"), else the slug of the name. Deriving
 * the key from the short ID rather than the whole composed name keeps keys
 * short and stable — the composed name changes as the schema parts are edited,
 * the ID does not. Returns "" only when BOTH are empty (validateInput then
 * fails on the required name, never on the key).
 */
export function keyFromIdOrName(uniqueId: string, name: string): string {
  return slugify(uniqueId) || slugify(name);
}

// ---------------------------------------------------------------------------
// Clone — derive a NEW experiment input from an existing one.
// ---------------------------------------------------------------------------

/**
 * The name for a clone: swap the EXP id token for `newExpId` so the copy gets
 * its own counter id (EXP001 → EXP007) while keeping the rest of the 4-part
 * schema. A hand-edited name with no EXP id can't be re-slotted, so it just
 * gains a " (copy)" suffix — still distinct from its source.
 */
export function cloneName(sourceName: string, newExpId: string): string {
  return EXP_ID_RE.test(sourceName)
    ? sourceName.replace(EXP_ID_RE, newExpId)
    : `${sourceName} (copy)`;
}

/**
 * Build the ExperimentInput for a CLONE of `source`, given a freshly-allocated
 * `newExpId` (the caller derives it via nextExpId over every live+archived
 * key/name). A clone is a brand-new test seeded from an existing one:
 *   - key + EXP id are fresh — experiment.key is a global PK, so a copied key
 *     would collide;
 *   - the name is recomposed with the new id (cloneName);
 *   - the YouTrack ticket is CLEARED — a new test tracks its own ticket, never
 *     inherits the source's;
 *   - it starts PAUSED (active:false — the new-test default, so it can be
 *     reviewed / A-A-checked before taking real traffic);
 *   - business, goal metric, description, start date and the full variant set
 *     (splits, control, theme slugs) copy verbatim — they already satisfy
 *     validateInput, so the clone is immediately valid.
 * Pure: the caller allocates newExpId and persists the result.
 */
export function buildCloneInput(source: StoredExperiment, newExpId: string): ExperimentInput {
  const name = cloneName(source.name, newExpId);
  return {
    name,
    key: keyFromIdOrName(newExpId, name),
    business: source.business,
    goalMetric: source.goalMetric,
    startDate: source.startDate,
    description: source.description || undefined,
    youtrackTicket: "",
    active: false,
    variants: source.variants.map((v) => ({
      key: v.key,
      rolloutPercentage: v.rolloutPercentage,
      themeSlug: v.themeSlug,
      isControl: v.isControl,
    })),
  };
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
 * Even 0-100 split across `count` arms, as whole numbers that sum to EXACTLY
 * 100 (validateInput requires the exact 100 — never 99 or 101). The remainder
 * from the integer division is spread one point at a time onto the leading arms,
 * so 3 arms → [34, 33, 33] and 7 arms → [15, 15, 15, 14, 14, 14, 14]. Returns
 * [] for count ≤ 0. Used by the form's "Split evenly" button and the A/A preset.
 */
export function evenSplit(count: number): number[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  const n = Math.floor(count);
  const base = Math.floor(100 / n);
  const remainder = 100 - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
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
  if (!BUSINESSES.some((b) => b.label === input.business)) {
    return `Business must be one of: ${BUSINESSES.map((b) => b.label).join(", ")}.`;
  }
  if (!allowedGoalMetrics.includes(input.goalMetric)) {
    return `Goal metric must be one of: ${allowedGoalMetrics.join(", ")}.`;
  }
  if (!ISO_DATE_RE.test(input.startDate)) {
    return "Start date must be a valid date (YYYY-MM-DD).";
  }
  // YouTrack ticket is optional; when present it must be a bare issue ID
  // (GP-603) or a full pasted URL.
  if (
    input.youtrackTicket !== undefined &&
    input.youtrackTicket.trim().length > 0 &&
    !isValidYoutrackTicket(input.youtrackTicket)
  ) {
    return "YouTrack ticket must be an issue ID like GP-603, or a full ticket URL.";
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
