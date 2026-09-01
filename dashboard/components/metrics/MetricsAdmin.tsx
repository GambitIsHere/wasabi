"use client";

// ============================================================================
// Admin metrics CRUD — add/edit/enable-disable/delete a registry metric
// without a deploy. Single-page, client-managed: list + create/edit form +
// delete confirm all live here; app/admin/metrics/page.tsx (server) supplies
// the initial list (listMetricsUncached()) and this component POSTs/PATCHes/
// DELETEs through app/api/admin/metrics/*, then router.refresh()s so the
// server re-reads the DB — same "server is the source of truth, client holds
// only transient UI state" pattern as components/ExperimentControls.tsx.
//
// Dropdowns, not free text, for kind/direction/unit/field pickers (a typo'd
// field name would otherwise silently produce a dead metric — metricValue
// returns null for every row and nobody notices until a chart looks empty;
// see lib/metrics-core.ts's VARIANT_ROW_NUMERIC_FIELDS doc comment).
// ============================================================================
import { useId, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DECIMALS_MAX,
  DESCRIPTION_MAX,
  DIRECTIONS,
  LABEL_MAX,
  METRIC_KEY_RE,
  METRIC_KINDS,
  METRIC_UNITS,
  VARIANT_ROW_NUMERIC_FIELDS,
  parseDenominatorFields,
  validateMetricDef,
  type Direction,
  type MetricDef,
  type MetricInput,
  type MetricKind,
  type MetricUnit,
} from "@/lib/metrics-core";

interface Props {
  initialMetrics: MetricDef[];
}

/** What the page is doing right now: browsing, creating, or editing one row. */
type Mode = { type: "closed" } | { type: "create" } | { type: "edit"; key: string };

// ---------------------------------------------------------------------------
// Form state — kept as strings for the numeric inputs (same reasoning as
// ExperimentForm's VariantDraft.rollout: an input can be transiently empty
// while typing) and a string[] for the denominator multi-select, joined with
// "+" only at submit time (see buildPayload).
// ---------------------------------------------------------------------------

interface FormState {
  key: string;
  label: string;
  description: string;
  kind: MetricKind;
  direction: Direction;
  unit: MetricUnit;
  numeratorField: string;
  denominatorFields: string[];
  valueField: string;
  decimals: string;
  isGoal: boolean;
  showInTable: boolean;
  displayOrder: string;
  enabled: boolean;
}

function blankForm(): FormState {
  return {
    key: "",
    label: "",
    description: "",
    kind: "ratio",
    direction: "higher_is_better",
    unit: "percent",
    numeratorField: "",
    denominatorFields: [],
    valueField: "",
    decimals: "1",
    isGoal: false,
    showInTable: true,
    displayOrder: "100",
    enabled: true,
  };
}

function formFromMetric(m: MetricDef): FormState {
  return {
    key: m.key,
    label: m.label,
    description: m.description,
    kind: m.kind,
    direction: m.direction,
    unit: m.unit,
    numeratorField: m.numeratorField ?? "",
    denominatorFields: parseDenominatorFields(m.denominatorField) ?? [],
    valueField: m.valueField ?? "",
    decimals: String(m.decimals),
    isGoal: m.isGoal,
    showInTable: m.showInTable,
    displayOrder: String(m.displayOrder),
    enabled: m.enabled,
  };
}

/** FormState → MetricInput, nulling out whichever of numerator/denominator vs
 *  value doesn't apply to the CURRENT kind — so switching a metric's kind
 *  during an edit never leaves a stale, irrelevant field value behind in the
 *  DB (harmless to validateMetricDef, which only checks the relevant branch,
 *  but misleading data otherwise). */
function buildPayload(f: FormState): MetricInput {
  const isRatio = f.kind === "ratio";
  return {
    key: f.key.trim(),
    label: f.label,
    description: f.description,
    kind: f.kind,
    direction: f.direction,
    unit: f.unit,
    numeratorField: isRatio ? f.numeratorField || null : null,
    denominatorField: isRatio ? f.denominatorFields.join("+") || null : null,
    valueField: isRatio ? null : f.valueField || null,
    decimals: Number.parseInt(f.decimals, 10),
    isGoal: f.isGoal,
    showInTable: f.showInTable,
    displayOrder: Number.parseInt(f.displayOrder, 10),
    enabled: f.enabled,
  };
}

/** Build the full-payload PATCH body for a pure enable/disable toggle — the
 *  API always expects a complete MetricInput (see parse-input.ts), so this
 *  resends every current field with only `enabled` flipped. */
function toggledPayload(m: MetricDef): MetricInput {
  return {
    key: m.key,
    label: m.label,
    description: m.description,
    kind: m.kind,
    direction: m.direction,
    unit: m.unit,
    numeratorField: m.numeratorField,
    denominatorField: m.denominatorField,
    valueField: m.valueField,
    decimals: m.decimals,
    isGoal: m.isGoal,
    showInTable: m.showInTable,
    displayOrder: m.displayOrder,
    enabled: !m.enabled,
  };
}

// ---------------------------------------------------------------------------
// Shared field styling — same classes ExperimentForm/ImportVwoForm use, so
// this page reads as part of the same app rather than a bolted-on tool.
// ---------------------------------------------------------------------------

const INPUT_CLS =
  "w-full rounded-md border border-line-strong bg-bg px-2.5 py-1.5 text-xs text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40";
const LABEL_CLS = "text-[11px] font-medium text-muted";

async function readJsonSafe(res: Response): Promise<{ ok: boolean; reason?: string; key?: string }> {
  try {
    return (await res.json()) as { ok: boolean; reason?: string; key?: string };
  } catch {
    return { ok: false, reason: `Server returned ${res.status} ${res.statusText}.` };
  }
}

// ---------------------------------------------------------------------------
// Top-level component
// ---------------------------------------------------------------------------

export function MetricsAdmin({ initialMetrics }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>({ type: "closed" });
  const [pending, startTransition] = useTransition();
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState<string | null>(null);

  const metrics = initialMetrics; // server is the source of truth; router.refresh() re-supplies this prop after a write
  const existingKeys = useMemo(() => new Set(metrics.map((m) => m.key)), [metrics]);

  function openCreate() {
    setRowError(null);
    setMode({ type: "create" });
  }
  function openEdit(key: string) {
    setRowError(null);
    setMode({ type: "edit", key });
  }
  function closeForm() {
    setMode({ type: "closed" });
  }

  function afterWrite(status: string) {
    closeForm();
    setRowStatus(status);
    setRowError(null);
    router.refresh();
  }

  function toggleEnabled(m: MetricDef) {
    setRowError(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/metrics/${encodeURIComponent(m.key)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toggledPayload(m)),
      });
      const body = await readJsonSafe(res);
      if (!body.ok) {
        setRowError(body.reason ?? "Failed to update metric.");
        return;
      }
      afterWrite(`${m.label} ${m.enabled ? "disabled" : "enabled"}.`);
    });
  }

  function deleteMetric(key: string, label: string) {
    setRowError(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/metrics/${encodeURIComponent(key)}`, { method: "DELETE" });
      const body = await readJsonSafe(res);
      if (!body.ok) {
        setRowError(body.reason ?? "Failed to delete metric.");
        return;
      }
      afterWrite(`${label} deleted.`);
    });
  }

  const editingMetric = mode.type === "edit" ? metrics.find((m) => m.key === mode.key) : undefined;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-faint">
          {metrics.length} {metrics.length === 1 ? "metric" : "metrics"} ·{" "}
          {metrics.filter((m) => m.enabled).length} enabled
        </p>
        {mode.type === "closed" && (
          <button
            type="button"
            onClick={openCreate}
            className="rounded-lg border border-line-strong bg-bg px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent/40 hover:text-accent"
          >
            + New metric
          </button>
        )}
      </div>

      {/* Status / error feedback — one live region for both, so a screen
          reader announces whichever just changed without a double-fire. */}
      <div aria-live="polite" className="space-y-2 empty:hidden">
        {rowStatus && !rowError && (
          <p
            role="status"
            className="rounded-lg border border-good/30 bg-good/10 px-3 py-2 text-xs text-good"
          >
            {rowStatus}
          </p>
        )}
        {rowError && (
          <p role="alert" className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
            {rowError}
          </p>
        )}
      </div>

      {mode.type === "create" && (
        <MetricForm
          formMode="create"
          title="New metric"
          initial={blankForm()}
          existingKeys={existingKeys}
          onCancel={closeForm}
          onSaved={afterWrite}
        />
      )}
      {mode.type === "edit" && editingMetric && (
        <MetricForm
          formMode="edit"
          title={`Edit ${editingMetric.label}`}
          initial={formFromMetric(editingMetric)}
          existingKeys={existingKeys}
          onCancel={closeForm}
          onSaved={afterWrite}
        />
      )}

      <MetricsTable
        metrics={metrics}
        pending={pending}
        onEdit={openEdit}
        onToggle={toggleEnabled}
        onDelete={deleteMetric}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function MetricsTable({
  metrics,
  pending,
  onEdit,
  onToggle,
  onDelete,
}: {
  metrics: MetricDef[];
  pending: boolean;
  onEdit: (key: string) => void;
  onToggle: (m: MetricDef) => void;
  onDelete: (key: string, label: string) => void;
}) {
  if (metrics.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong bg-surface px-6 py-10 text-center text-sm text-muted">
        No metrics yet — create one above.
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-line bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="text-left font-mono text-[11px] uppercase tracking-wider text-muted">
              <th scope="col" className="px-5 py-2.5 font-medium">Key</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Label</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Format</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Decimals</th>
              <th scope="col" className="px-3 py-2.5 text-center font-medium">Goal</th>
              <th scope="col" className="px-3 py-2.5 text-center font-medium">In table</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Order</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
              <th scope="col" className="px-5 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {metrics.map((m) => (
              <MetricRow key={m.key} m={m} pending={pending} onEdit={onEdit} onToggle={onToggle} onDelete={onDelete} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MetricRow({
  m,
  pending,
  onEdit,
  onToggle,
  onDelete,
}: {
  m: MetricDef;
  pending: boolean;
  onEdit: (key: string) => void;
  onToggle: (m: MetricDef) => void;
  onDelete: (key: string, label: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteBtnRef = useRef<HTMLButtonElement>(null);

  return (
    <tr className="text-fg transition-colors hover:bg-surface-hover">
      <td className="px-5 py-3 font-mono text-xs text-fg">{m.key}</td>
      <td className="px-3 py-3">
        <div>{m.label}</div>
        {m.description && <div className="mt-0.5 text-[11px] text-faint">{m.description}</div>}
      </td>
      <td className="px-3 py-3 font-mono text-[11px] text-muted">
        {m.kind} · {m.unit} · {m.direction === "higher_is_better" ? "higher is better" : "lower is better"}
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-muted">{m.decimals}</td>
      <td className="px-3 py-3 text-center">{m.isGoal ? <Check /> : <Dash />}</td>
      <td className="px-3 py-3 text-center">{m.showInTable ? <Check /> : <Dash />}</td>
      <td className="px-3 py-3 text-right tabular-nums text-muted">{m.displayOrder}</td>
      <td className="px-3 py-3">
        <EnabledPill enabled={m.enabled} />
      </td>
      <td className="px-5 py-3">
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => onEdit(m.key)}
            disabled={pending}
            className="rounded-md border border-line-strong bg-bg px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onToggle(m)}
            disabled={pending}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              m.enabled
                ? "border-warn/40 bg-warn/10 text-warn hover:bg-warn/20"
                : "border-good/40 bg-good/10 text-good hover:bg-good/20"
            }`}
          >
            {m.enabled ? "Disable" : "Enable"}
          </button>
          {!confirming ? (
            <button
              type="button"
              ref={deleteBtnRef}
              onClick={() => setConfirming(true)}
              disabled={pending}
              className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-faint transition-colors hover:border-bad/40 hover:text-bad disabled:cursor-not-allowed disabled:opacity-50"
            >
              Delete
            </button>
          ) : (
            <span
              className="flex items-center gap-1.5"
              onKeyDown={(e) => {
                if (e.key === "Escape") setConfirming(false);
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  onDelete(m.key, m.label);
                }}
                disabled={pending}
                className="rounded-md border border-bad/50 bg-bad/15 px-2.5 py-1 text-xs font-medium text-bad hover:bg-bad/25"
              >
                Confirm
              </button>
              <button
                type="button"
                ref={cancelRef}
                onClick={() => setConfirming(false)}
                disabled={pending}
                className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-muted hover:text-fg"
              >
                Cancel
              </button>
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

function Check() {
  return (
    <span className="text-good" aria-label="yes">
      ✓
    </span>
  );
}
function Dash() {
  return (
    <span className="text-faint" aria-label="no">
      —
    </span>
  );
}

/** Same visual language as components/pills.tsx's StatusPill (dot + pill,
 *  good/faint tokens) — a metric's enabled/disabled state is the same shape
 *  of fact as an experiment's active/paused one, so it should look like it. */
function EnabledPill({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-good/30 bg-good/10 px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-good">
      <span className="size-1.5 rounded-full bg-good" aria-hidden="true" />
      Enabled
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-bg px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-faint">
      <span className="size-1.5 rounded-full bg-faint" aria-hidden="true" />
      Disabled
    </span>
  );
}

// ---------------------------------------------------------------------------
// Create / edit form
// ---------------------------------------------------------------------------

function MetricForm({
  formMode,
  title,
  initial,
  existingKeys,
  onCancel,
  onSaved,
}: {
  formMode: "create" | "edit";
  title: string;
  initial: FormState;
  existingKeys: Set<string>;
  onCancel: () => void;
  onSaved: (status: string) => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [pending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const formId = useId();
  const isCreate = formMode === "create";

  const payload = useMemo(() => buildPayload(form), [form]);
  const clientError = useMemo(() => validateMetricDef(payload), [payload]);
  // Uniqueness only needs checking on create — in edit mode the key already
  // exists (it's this row) and would trivially "collide" with itself.
  const duplicateKeyError =
    isCreate && payload.key && existingKeys.has(payload.key)
      ? `A metric with key "${payload.key}" already exists.`
      : null;
  const validationError = clientError ?? duplicateKeyError;
  const canSubmit = validationError === null && !pending;

  function patch(p: Partial<FormState>) {
    setForm((f) => ({ ...f, ...p }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setServerError(null);
    startTransition(async () => {
      const url = isCreate ? "/api/admin/metrics" : `/api/admin/metrics/${encodeURIComponent(payload.key)}`;
      const res = await fetch(url, {
        method: isCreate ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await readJsonSafe(res);
      if (!body.ok) {
        setServerError(body.reason ?? "Save failed.");
        return;
      }
      onSaved(`${payload.label} ${isCreate ? "created" : "saved"}.`);
    });
  }

  const isRatio = form.kind === "ratio";

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border border-accent/25 bg-surface p-5"
      aria-labelledby={`${formId}-title`}
    >
      <h3 id={`${formId}-title`} className="font-display text-sm font-semibold text-fg">
        {title}
      </h3>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={LABEL_CLS}>Key</span>
          <input
            type="text"
            value={form.key}
            onChange={(e) => patch({ key: e.target.value.trim() })}
            disabled={!isCreate}
            placeholder="e.g. refund_rate"
            spellCheck={false}
            autoComplete="off"
            pattern={METRIC_KEY_RE.source}
            title="Lower-case letters, numbers and underscores, starting with a letter."
            className={`${INPUT_CLS} font-mono disabled:cursor-not-allowed disabled:opacity-60`}
          />
          <span className="text-[10px] text-faint">
            {isCreate
              ? "Lower-case letters, numbers, underscores; must start with a letter."
              : "Immutable once created."}
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL_CLS}>Label</span>
          <input
            type="text"
            value={form.label}
            onChange={(e) => patch({ label: e.target.value })}
            placeholder="e.g. Refund rate"
            maxLength={LABEL_MAX}
            className={INPUT_CLS}
          />
        </label>

        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="flex items-baseline justify-between">
            <span className={LABEL_CLS}>Description</span>
            <span className="font-mono text-[10px] tabular-nums text-faint">
              {form.description.length} / {DESCRIPTION_MAX}
            </span>
          </span>
          <textarea
            value={form.description}
            onChange={(e) => patch({ description: e.target.value })}
            rows={2}
            placeholder="1-2 sentence explanation shown as a tooltip on the results page."
            className={`${INPUT_CLS} resize-y leading-relaxed`}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL_CLS}>Kind</span>
          <select
            value={form.kind}
            onChange={(e) => patch({ kind: e.target.value as MetricKind })}
            className={INPUT_CLS}
          >
            {METRIC_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL_CLS}>Direction</span>
          <select
            value={form.direction}
            onChange={(e) => patch({ direction: e.target.value as Direction })}
            className={INPUT_CLS}
          >
            {DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {d === "higher_is_better" ? "Higher is better" : "Lower is better"}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL_CLS}>Unit</span>
          <select
            value={form.unit}
            onChange={(e) => patch({ unit: e.target.value as MetricUnit })}
            className={INPUT_CLS}
          >
            {METRIC_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL_CLS}>Decimals</span>
          <input
            type="number"
            min={0}
            max={DECIMALS_MAX}
            value={form.decimals}
            onChange={(e) => patch({ decimals: e.target.value })}
            className={`${INPUT_CLS} tabular-nums`}
          />
        </label>

        {isRatio ? (
          <>
            <label className="flex flex-col gap-1">
              <span className={LABEL_CLS}>Numerator field</span>
              <select
                value={form.numeratorField}
                onChange={(e) => patch({ numeratorField: e.target.value })}
                className={`${INPUT_CLS} font-mono`}
              >
                <option value="">— select —</option>
                {VARIANT_ROW_NUMERIC_FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className={LABEL_CLS}>
                Denominator field(s) <span className="text-faint">(ctrl/cmd-click for more than one — summed)</span>
              </span>
              <select
                multiple
                value={form.denominatorFields}
                onChange={(e) =>
                  patch({ denominatorFields: Array.from(e.target.selectedOptions).map((o) => o.value) })
                }
                size={4}
                className={`${INPUT_CLS} font-mono`}
              >
                {VARIANT_ROW_NUMERIC_FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className={LABEL_CLS}>Value field</span>
            <select
              value={form.valueField}
              onChange={(e) => patch({ valueField: e.target.value })}
              className={`${INPUT_CLS} font-mono`}
            >
              <option value="">— select —</option>
              {VARIANT_ROW_NUMERIC_FIELDS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1">
          <span className={LABEL_CLS}>Display order</span>
          <input
            type="number"
            step={10}
            value={form.displayOrder}
            onChange={(e) => patch({ displayOrder: e.target.value })}
            className={`${INPUT_CLS} tabular-nums`}
          />
        </label>

        <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={form.isGoal}
              onChange={(e) => patch({ isGoal: e.target.checked })}
              className="size-3.5 accent-[var(--color-accent)]"
            />
            Selectable as a goal metric
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={form.showInTable}
              onChange={(e) => patch({ showInTable: e.target.checked })}
              className="size-3.5 accent-[var(--color-accent)]"
            />
            Show as a column in the results table
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
              className="size-3.5 accent-[var(--color-accent)]"
            />
            Enabled
          </label>
        </div>
      </div>

      <div className="space-y-2" aria-live="polite">
        {validationError && (
          <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
            {validationError}
          </p>
        )}
        {serverError && (
          <p role="alert" className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
            {serverError}
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={!canSubmit} className="btn-primary px-4 py-2 text-sm">
          {pending ? "Saving…" : isCreate ? "Create metric" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-fg disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
