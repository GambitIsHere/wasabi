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
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  BUSINESSES,
  DESCRIPTION_MAX,
  GOAL_METRICS,
  THEME_SLUGS,
  slugify,
  splitTotal,
  validateInput,
} from "@/lib/mgmt";
import type { ExperimentInput, VariantInput } from "@/lib/mgmt";
import { createExperiment, updateExperiment } from "@/app/actions";

interface Props {
  mode: "create" | "edit";
  /** Pre-filled values for edit; sensible defaults for create. */
  initial: ExperimentInput;
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

export function ExperimentForm({ mode, initial }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const [name, setName] = useState(initial.name);
  const [business, setBusiness] = useState(initial.business);
  const [goalMetric, setGoalMetric] = useState(initial.goalMetric);
  const [startDate, setStartDate] = useState(initial.startDate);
  const [description, setDescription] = useState(initial.description ?? "");
  const [drafts, setDrafts] = useState<VariantDraft[]>(toDrafts(initial.variants));

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
    variants,
  };
  const validationError = validateInput(candidate);
  const canSubmit = validationError === null && !pending;

  // --- variant row mutators ---
  function updateRow(i: number, patch: Partial<VariantDraft>) {
    setDrafts((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function setControl(i: number) {
    setDrafts((rows) => rows.map((r, idx) => ({ ...r, isControl: idx === i })));
  }
  function addRow() {
    setDrafts((rows) => [
      ...rows,
      {
        key: `variant_${rows.length + 1}`,
        rollout: "0",
        themeSlug: THEME_SLUGS[0],
        isControl: false,
      },
    ]);
  }
  function removeRow(i: number) {
    setDrafts((rows) => {
      if (rows.length <= 2) return rows; // keep the ≥2 invariant
      const next = rows.filter((_, idx) => idx !== i);
      // If we removed the control, promote the first remaining row.
      if (!next.some((r) => r.isControl) && next[0]) next[0].isControl = true;
      return [...next];
    });
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
            <span className="text-[11px] text-faint">
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
                  description.length > DESCRIPTION_MAX ? "text-bad" : "text-faint"
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
              {GOAL_METRICS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
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
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <h2 className="font-display text-sm font-semibold text-fg">Variants</h2>
            <p className="mt-0.5 text-xs text-faint">
              Pick exactly one control. Splits must sum to 100%.
            </p>
          </div>
          <SplitBadge total={total} ok={totalOk} />
        </header>

        <div className="divide-y divide-line">
          {drafts.map((d, i) => (
            <div
              key={i}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-5 py-3 sm:grid-cols-[auto_1.2fr_5rem_1fr_auto]"
            >
              {/* control radio */}
              <label className="flex items-center gap-1.5 text-[11px] text-muted">
                <input
                  type="radio"
                  name="control"
                  checked={d.isControl}
                  onChange={() => setControl(i)}
                  className="size-3.5 accent-[var(--color-info)]"
                />
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
                  className="w-full rounded-md border border-line-strong bg-bg px-2.5 py-1.5 pr-6 text-right font-mono text-xs tabular-nums text-fg focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-faint">
                  %
                </span>
              </div>

              {/* theme slug — free text (any global-api Theme slug works across
                  all businesses); the common ones are suggested via the datalist
                  below. Validation is format-based (see mgmt.ts THEME_SLUG_RE). */}
              <input
                type="text"
                list="wasabi-theme-slugs"
                value={d.themeSlug}
                onChange={(e) => updateRow(i, { themeSlug: e.target.value })}
                placeholder="tu_lov_uk_19"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                className="w-full rounded-md border border-line-strong bg-bg px-2.5 py-1.5 font-mono text-xs text-accent/90 placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
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
                className="rounded-md border border-line-strong bg-bg px-2 py-1 text-xs text-faint transition-colors hover:border-bad/40 hover:text-bad disabled:cursor-not-allowed disabled:opacity-40"
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
            onClick={addRow}
            className="rounded-lg border border-line-strong bg-bg px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent/40 hover:text-accent"
          >
            + Add variant
          </button>
        </div>
      </section>

      {/* --- Errors + submit --- */}
      <div className="space-y-3">
        {validationError && (
          <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
            {validationError}
          </p>
        )}
        {serverError && (
          <p className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">
            {serverError}
          </p>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-lg bg-accent px-5 py-2.5 font-display text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
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
