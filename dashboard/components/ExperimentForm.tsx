"use client";

// ============================================================================
// ExperimentForm — the create/edit form (client).
// ----------------------------------------------------------------------------
// Drives both the New page (mode="create") and the Edit page (mode="edit"). A
// real form with a dynamic variants editor: add/remove rows, a single control
// radio, a live split total with ✓/✗, and submit disabled until the SAME
// validation the server runs (lib/mgmt.validateInput) passes. On success it
// redirects to the experiment detail; on a server error it shows it inline.
// ============================================================================
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  BUSINESSES,
  DESCRIPTION_MAX,
  THEME_SLUGS,
  evenSplit,
  slugify,
  splitTotal,
  validateInput,
} from "@/lib/mgmt";
import type { ExperimentInput, VariantInput } from "@/lib/mgmt";
import { createExperiment, updateExperiment } from "@/app/actions";

/** One goal-metric dropdown option: `key` is what's stored, `label` is what's
 *  shown. Server-fetched (this is a client component; it can't read the
 *  registry DB itself) — see app/experiments/new|[key]/edit's page.tsx. */
export interface GoalMetricOption {
  key: string;
  label: string;
}

interface Props {
  mode: "create" | "edit";
  /** Pre-filled values for edit; sensible defaults for create. */
  initial: ExperimentInput;
  /** Registry metrics where isGoal is true, display-ordered. May NOT include
   *  `initial.goalMetric` (e.g. editing an experiment whose stored goal metric
   *  predates the registry, or was since renamed/disabled) — see goalOptions
   *  below, which unions it in so editing degrades gracefully instead of
   *  crashing or silently swapping the value. */
  goalMetricOptions: GoalMetricOption[];
}

/** Editable row state (split kept as string so the input can be transiently empty). */
interface VariantDraft {
  key: string;
  rollout: string;
  themeSlug: string;
  isControl: boolean;
}

function toDrafts(variants: VariantInput[]): VariantDraft[] {
  return variants.map((v) => ({
    key: v.key,
    rollout: String(v.rolloutPercentage),
    themeSlug: v.themeSlug,
    isControl: v.isControl,
  }));
}

function draftsToVariants(drafts: VariantDraft[]): VariantInput[] {
  return drafts.map((d) => ({
    key: d.key.trim(),
    rolloutPercentage: Number.parseInt(d.rollout, 10) || 0,
    themeSlug: d.themeSlug,
    isControl: d.isControl,
  }));
}

export function ExperimentForm({ mode, initial, goalMetricOptions }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const [name, setName] = useState(initial.name);
  const [business, setBusiness] = useState(initial.business);
  const [goalMetric, setGoalMetric] = useState(initial.goalMetric);
  const [startDate, setStartDate] = useState(initial.startDate);
  const [description, setDescription] = useState(initial.description ?? "");
  const [drafts, setDrafts] = useState<VariantDraft[]>(toDrafts(initial.variants));

  // CREATE-ONLY launch state. A new test defaults to PAUSED (queued) so it can
  // be wired + A/A-checked before real traffic; this is threaded to the store as
  // ExperimentInput.active (see candidate below). Edit never renders this — the
  // active flag is owned there by ExperimentControls — so edit-mode persistence
  // is unchanged.
  const [active, setActive] = useState<boolean>(initial.active ?? false);

  // CREATE-ONLY A/A preset: make every arm identical (same theme slug) with an
  // even split, to validate assignment + goal capture before running a real A/B.
  // Turning it off restores the theme slugs the arms had before it was enabled.
  const [aaMode, setAaMode] = useState(false);
  const aaPrevSlugs = useRef<string[] | null>(null);

  // The dropdown's real option list: the registry's isGoal metrics, plus the
  // experiment's OWN current goal metric if it isn't already one of them —
  // "show the raw key" for a legacy/orphaned value (e.g. a pre-registry
  // "revenue_per_acquired") rather than silently dropping it from the select
  // or forcing the user to pick something else before they can save anything.
  const goalOptions = useMemo<GoalMetricOption[]>(() => {
    if (goalMetricOptions.some((o) => o.key === initial.goalMetric)) return goalMetricOptions;
    return [
      ...goalMetricOptions,
      { key: initial.goalMetric, label: `${initial.goalMetric} — not in registry` },
    ];
  }, [goalMetricOptions, initial.goalMetric]);
  // validateInput takes the allowed set explicitly (it's a pure module — see
  // lib/mgmt.ts — and can't read the registry DB itself); this mirrors
  // exactly what app/actions.ts's server action independently re-derives, so
  // a submit that passes client-side validation also passes server-side.
  const allowedGoalKeys = useMemo(() => goalOptions.map((o) => o.key), [goalOptions]);

  // Focus management for add/remove variant rows — keeps keyboard focus from
  // getting stranded when the row list changes shape.
  const rowsRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<"add" | "remove" | null>(null);

  useEffect(() => {
    const intent = pendingFocus.current;
    if (!intent) return;
    pendingFocus.current = null;
    if (intent === "add") {
      const keys = rowsRef.current?.querySelectorAll<HTMLInputElement>("[data-role='variant-key']");
      keys?.[keys.length - 1]?.focus(); // focus the newly-added row's key input
    } else {
      addBtnRef.current?.focus(); // safe target after a removal
    }
  }, [drafts.length]);

  // On create the key tracks the name (slug); on edit it's immutable.
  const resolvedKey =
    mode === "edit" ? (initial.key ?? "") : slugify(name) || "—";

  const variants = useMemo(() => draftsToVariants(drafts), [drafts]);
  const total = splitTotal(variants);
  const totalOk = total === 100;

  const candidate: ExperimentInput = {
    name,
    key: mode === "edit" ? initial.key : undefined,
    business,
    goalMetric,
    startDate,
    description,
    // Launch state is a create-time initial value only. On edit it's left
    // undefined so the update path never touches the active flag (owned by
    // ExperimentControls) — see ExperimentInput.active.
    active: mode === "create" ? active : undefined,
    variants,
  };
  const validationError = validateInput(candidate, allowedGoalKeys);
  const canSubmit = validationError === null && !pending;

  // --- variant row mutators ---
  /** The arm whose theme every arm mirrors while A/A mode is on (the control,
   *  or the first row as a fallback). */
  function sharedSlug(rows: VariantDraft[]): string {
    return (rows.find((r) => r.isControl) ?? rows[0])?.themeSlug ?? THEME_SLUGS[0];
  }
  /** Even-split the rollout column across `rows`, summing to exactly 100. */
  function withEvenSplit(rows: VariantDraft[]): VariantDraft[] {
    const splits = evenSplit(rows.length);
    return rows.map((r, i) => ({ ...r, rollout: String(splits[i] ?? 0) }));
  }

  function updateRow(i: number, patch: Partial<VariantDraft>) {
    setDrafts((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  /** Theme edits. In A/A mode every arm is kept identical, so a change to the
   *  (editable) control arm propagates to all rows; otherwise only row `i`. */
  function setTheme(i: number, value: string) {
    setDrafts((rows) =>
      aaMode
        ? rows.map((r) => ({ ...r, themeSlug: value }))
        : rows.map((r, idx) => (idx === i ? { ...r, themeSlug: value } : r)),
    );
  }
  function setControl(i: number) {
    setDrafts((rows) => rows.map((r, idx) => ({ ...r, isControl: idx === i })));
  }
  /** Distribute 100% across the current arms as evenly as possible. */
  function splitEvenly() {
    setDrafts((rows) => withEvenSplit(rows));
  }
  function addRow() {
    pendingFocus.current = "add";
    setDrafts((rows) => {
      const next = [
        ...rows,
        {
          key: `variant_${rows.length + 1}`,
          rollout: "0",
          themeSlug: aaMode ? sharedSlug(rows) : THEME_SLUGS[0],
          isControl: false,
        },
      ];
      // A/A must stay identical + even after the arm count changes.
      return aaMode ? withEvenSplit(next) : next;
    });
  }
  function removeRow(i: number) {
    if (drafts.length > 2) pendingFocus.current = "remove";
    setDrafts((rows) => {
      if (rows.length <= 2) return rows; // keep the ≥2 invariant
      let next = rows.filter((_, idx) => idx !== i);
      // If we removed the control, promote the first remaining row (immutably).
      if (!next.some((r) => r.isControl) && next[0]) {
        next = next.map((r, idx) => (idx === 0 ? { ...r, isControl: true } : r));
      }
      // A/A must stay even after the arm count changes.
      return aaMode ? withEvenSplit(next) : next;
    });
  }
  /** Toggle the A/A preset. Enabling snapshots the current theme slugs, then
   *  makes every arm identical (all = the control's slug) with an even split.
   *  Disabling restores the snapshotted slugs by position where they still
   *  exist, leaving splits/keys as-is (non-destructive). */
  function toggleAaMode() {
    setDrafts((rows) => {
      if (!aaMode) {
        aaPrevSlugs.current = rows.map((r) => r.themeSlug);
        const shared = sharedSlug(rows);
        return withEvenSplit(rows.map((r) => ({ ...r, themeSlug: shared })));
      }
      const snapshot = aaPrevSlugs.current;
      aaPrevSlugs.current = null;
      return rows.map((r, i) => ({ ...r, themeSlug: snapshot?.[i] ?? r.themeSlug }));
    });
    setAaMode((on) => !on);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setServerError(null);
    startTransition(async () => {
      const res =
        mode === "create"
          ? await createExperiment(candidate)
          : await updateExperiment(initial.key ?? "", candidate);
      if (res.ok) {
        router.push(`/experiments/${res.key}`);
        router.refresh();
      } else {
        setServerError(res.error);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      {/* --- Core fields --- */}
      <section className="rounded-xl border border-line bg-surface p-5">
        <h2 className="font-display text-sm font-semibold text-fg">Basics</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-xs font-medium text-muted">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Top-Up Billing UK"
              className="rounded-lg border border-line-strong bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
            <span className="text-[11px] text-muted">
              Key:{" "}
              <code className="font-mono text-accent/90">{resolvedKey}</code>
              {mode === "edit" && (
                <span className="ml-1 text-faint">(immutable)</span>
              )}
            </span>
          </label>

          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="flex items-baseline justify-between">
              <span className="text-xs font-medium text-muted">Description</span>
              <span
                className={`font-mono text-[10px] tabular-nums ${
                  description.length > DESCRIPTION_MAX ? "text-bad" : "text-muted"
                }`}
              >
                {description.length} / {DESCRIPTION_MAX}
              </span>
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Why this test exists — the hypothesis, what you'll learn, and any wiring/context the dashboard reader needs. Shown on the card and the detail header."
              rows={3}
              className="resize-y rounded-lg border border-line-strong bg-bg px-3 py-2 text-sm leading-relaxed text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Business</span>
            <select
              value={business}
              onChange={(e) => setBusiness(e.target.value)}
              className="rounded-lg border border-line-strong bg-bg px-3 py-2 text-sm text-fg focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
            >
              {BUSINESSES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Goal metric</span>
            <select
              value={goalMetric}
              onChange={(e) => setGoalMetric(e.target.value)}
              className="rounded-lg border border-line-strong bg-bg px-3 py-2 font-mono text-sm text-fg focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
            >
              {goalOptions.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-faint">
              The goal event must be captured from the storefront, or the test
              measures nothing.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Start date</span>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="rounded-lg border border-line-strong bg-bg px-3 py-2 text-sm text-fg focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </label>
        </div>
      </section>

      {/* --- Variants editor --- */}
      <section className="rounded-xl border border-line bg-surface">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div>
            <h2 className="font-display text-sm font-semibold text-fg">Variants</h2>
            <p className="mt-0.5 text-xs text-faint">
              Pick exactly one control. Splits must sum to 100%.
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={splitEvenly}
              className="rounded-lg border border-line-strong bg-bg px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-accent/40 hover:text-accent"
            >
              Split evenly
            </button>
            <SplitBadge total={total} ok={totalOk} />
          </div>
        </header>

        {/* A/A preset — CREATE ONLY. Makes every arm identical to validate the
            plumbing before running a real A/B. */}
        {mode === "create" && (
          <div className="border-b border-line bg-bg/40 px-5 py-3">
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={aaMode}
                onChange={toggleAaMode}
                className="mt-0.5 size-3.5 accent-[var(--color-info)]"
              />
              <span className="space-y-0.5">
                <span className="block text-xs font-medium text-fg">
                  Set up as an A/A test — identical arms, to validate tracking
                </span>
                {aaMode && (
                  <span className="block text-[11px] text-faint">
                    All arms now route to the same theme with an even split. An
                    A/A confirms assignment works and the goal event fires before
                    you run a real A/B.
                  </span>
                )}
              </span>
            </label>
          </div>
        )}

        <div ref={rowsRef} className="divide-y divide-line">
          {drafts.map((d, i) => (
            <div
              key={i}
              className="grid grid-cols-1 gap-2 px-5 py-3 sm:grid-cols-[auto_1.2fr_5rem_1fr_auto] sm:items-center sm:gap-3"
            >
              {/* control radio */}
              <label className="flex items-center gap-1.5 text-[11px] text-muted">
                <input
                  type="radio"
                  name="control"
                  checked={d.isControl}
                  onChange={() => setControl(i)}
                  aria-label={`Use variant ${d.key} as control`}
                  className="size-3.5 accent-[var(--color-info)]"
                />
                <span className="sm:hidden">Control</span>
                <span className="hidden sm:inline">ctrl</span>
              </label>

              {/* key */}
              <input
                type="text"
                value={d.key}
                onChange={(e) => updateRow(i, { key: e.target.value })}
                placeholder="variant key"
                spellCheck={false}
                autoComplete="off"
                data-role="variant-key"
                aria-label={`Variant ${i + 1} key`}
                className="rounded-md border border-line-strong bg-bg px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />

              {/* split */}
              <div className="relative">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={d.rollout}
                  onChange={(e) => updateRow(i, { rollout: e.target.value })}
                  aria-label={`Variant ${d.key} traffic split percentage`}
                  className="w-full rounded-md border border-line-strong bg-bg px-2.5 py-1.5 pr-6 text-right font-mono text-xs tabular-nums text-fg focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-faint">
                  %
                </span>
              </div>

              {/* theme slug — free text (any global-api Theme slug works across
                  all businesses); the common ones are suggested via the datalist
                  below. Validation is format-based (see mgmt.ts THEME_SLUG_RE).
                  In A/A mode every arm mirrors the control's slug, so only the
                  control's field is editable and the rest are shown read-only. */}
              <input
                type="text"
                list="wasabi-theme-slugs"
                value={d.themeSlug}
                onChange={(e) => setTheme(i, e.target.value)}
                readOnly={aaMode && !d.isControl}
                placeholder="tu_lov_uk_19"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                title={
                  aaMode && !d.isControl
                    ? "A/A mode — mirrors the control arm's theme"
                    : undefined
                }
                className={`w-full rounded-md border border-line-strong bg-bg px-2.5 py-1.5 font-mono text-xs text-accent/90 placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40 ${
                  aaMode && !d.isControl ? "cursor-not-allowed opacity-60" : ""
                }`}
                aria-label={`Theme slug for variant ${d.key}`}
              />

              {/* remove */}
              <button
                type="button"
                onClick={() => removeRow(i)}
                disabled={drafts.length <= 2}
                title={
                  drafts.length <= 2
                    ? "An experiment needs at least 2 variants"
                    : "Remove variant"
                }
                className="justify-self-end rounded-md border border-line-strong bg-bg px-2 py-1 text-xs text-faint transition-colors hover:border-bad/40 hover:text-bad disabled:cursor-not-allowed disabled:opacity-40 sm:justify-self-auto"
                aria-label={`Remove variant ${d.key}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        {/* Shared autocomplete for every variant's theme-slug input — suggestions
            only; any format-valid slug can be typed (all businesses, future slugs). */}
        <datalist id="wasabi-theme-slugs">
          {THEME_SLUGS.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>

        <div className="border-t border-line px-5 py-3">
          <button
            type="button"
            ref={addBtnRef}
            onClick={addRow}
            className="rounded-lg border border-line-strong bg-bg px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent/40 hover:text-accent"
          >
            + Add variant
          </button>
        </div>
      </section>

      {/* --- Launch state (CREATE ONLY) --- */}
      {mode === "create" && (
        <section className="rounded-xl border border-line bg-surface p-5">
          <h2 className="font-display text-sm font-semibold text-fg">Launch</h2>
          <p className="mt-0.5 text-xs text-faint">
            A new test starts paused so you can wire the storefront and run an A/A
            check before it takes real traffic. Activate it from the experiment
            page when it&apos;s ready.
          </p>
          <div
            role="radiogroup"
            aria-label="Initial launch state"
            className="mt-4 grid gap-2 sm:grid-cols-2"
          >
            <LaunchOption
              selected={!active}
              onSelect={() => setActive(false)}
              title="Start paused"
              subtitle="Queued — no traffic until you activate it"
            />
            <LaunchOption
              selected={active}
              onSelect={() => setActive(true)}
              title="Start active"
              subtitle="Live immediately — assigns traffic on save"
            />
          </div>
        </section>
      )}

      {/* --- Errors + submit --- */}
      <div className="space-y-3">
        {/* Only the errors live in the announced region — not the submit row,
            whose "Saving…" relabel would otherwise be read out on every submit. */}
        <div className="space-y-3 empty:hidden" aria-live="polite">
          {validationError && (
            <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
              {validationError}
            </p>
          )}
          {serverError && (
            <p
              role="alert"
              className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad"
            >
              {serverError}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!canSubmit}
            className="btn-primary px-5 py-2.5"
          >
            {pending
              ? "Saving…"
              : mode === "create"
                ? "Create experiment"
                : "Save changes"}
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            disabled={pending}
            className="rounded-lg border border-line-strong bg-surface px-4 py-2.5 text-sm font-medium text-muted transition-colors hover:text-fg disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}

/** One selectable launch-state card (radio semantics) for create mode. */
function LaunchOption({
  selected,
  onSelect,
  title,
  subtitle,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex flex-col items-start gap-0.5 rounded-lg border px-3.5 py-2.5 text-left transition-colors ${
        selected
          ? "border-accent/50 bg-accent/10"
          : "border-line-strong bg-bg hover:border-accent/30"
      }`}
    >
      <span className={`text-sm font-medium ${selected ? "text-fg" : "text-muted"}`}>
        {title}
      </span>
      <span className="text-[11px] text-faint">{subtitle}</span>
    </button>
  );
}

/** Live split total with a clear ✓ / ✗ against 100%. */
function SplitBadge({ total, ok }: { total: number; ok: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums ${
        ok
          ? "border-good/40 bg-good/10 text-good"
          : "border-bad/40 bg-bad/10 text-bad"
      }`}
    >
      <span aria-hidden="true">{ok ? "✓" : "✗"}</span>
      {total}% / 100%
    </span>
  );
}
