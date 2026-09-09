"use client";

// ============================================================================
// Wasabi — per-org Tickets: the kanban board (client).
// ----------------------------------------------------------------------------
// Four columns (backlog → next → running → shipped), cards grouped by status.
// DRAG a card onto another column to change its status — the drop targets are
// the STATUS COLUMNS (data-status), hit-tested with document.elementFromPoint.
// The drag mechanics are lifted straight from components/roadmap/EditableRunway:
// pointer events (pointerdown → window pointermove/up via one AbortController),
// a DRAG_THRESHOLD that separates a click from a drag, an optimistic state move
// with rollback-on-failure, and a floating ghost that follows the cursor. A
// press below the threshold is a click that opens the card's edit form.
//
// KEYBOARD PARITY: the drag is pointer-only, so the edit form's Status <select>
// is the keyboard-accessible way to move a card — a11y is covered without a
// bespoke keyboard DnD. When `editable` is false (viewer, or the DB was
// unreachable) cards neither drag nor open, and a read-only note is shown.
//
// Writes go through the server actions in app/tickets/actions.ts (each gated by
// requireRole("editor")); the pure grouping / drop-position logic lives in the
// node-testable lib/tickets-board.ts.
// ============================================================================
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  TICKET_DESCRIPTION_MAX,
  TICKET_STATUS_META,
  TICKET_STATUSES,
  TICKET_TITLE_MAX,
  isTicketStatus,
  validateTicketInput,
  validateTicketPatch,
  type Ticket,
  type TicketActionResult,
  type TicketInput,
  type TicketStatus,
} from "@/lib/tickets";
import { endOfColumnPosition, groupTicketsByStatus } from "@/lib/tickets-board";
import {
  createTicketAction,
  deleteTicketAction,
  moveTicketAction,
  updateTicketAction,
} from "@/app/tickets/actions";

/** One assignable member — resolved from lib/membership.listMembersForOrg on
 *  the server. `label` is the display name, falling back to the email. */
export interface MemberOption {
  userId: string;
  label: string;
}

/** One experiment the ticket can be loosely linked to (a plain key, never a FK
 *  — see lib/tickets.ts). `name` is the human label; `key` deep-links to
 *  /experiments/{key}. */
export interface ExperimentOption {
  key: string;
  name: string;
}

interface Props {
  tickets: Ticket[];
  members: MemberOption[];
  experiments: ExperimentOption[];
  /** editor+ AND the DB is reachable — gates create / drag / edit affordances.
   *  UX only: the server actions re-authorize via requireRole("editor"). */
  editable: boolean;
}

// Pixels the pointer must travel before a press becomes a drag (below this it's
// a click that opens the card). Same value + intent as EditableRunway.
const DRAG_THRESHOLD = 5;

/** A signature that changes only when the SERVER data actually changes — so the
 *  resync effect skips our own optimistic edits (which never touch props). */
function signature(tickets: Ticket[]): string {
  return tickets
    .map(
      (t) =>
        `${t.id}:${t.status}#${t.position}:${t.title}:${t.assigneeUserId ?? ""}:${t.experimentKey ?? ""}`,
    )
    .join("|");
}

/** The status column under a viewport point, if any — the drop hit-test. */
function columnAt(x: number, y: number): TicketStatus | null {
  const el = document.elementFromPoint(x, y);
  const column = el?.closest<HTMLElement>('[data-column="1"]');
  const status = column?.dataset.status;
  return isTicketStatus(status) ? status : null;
}

// Live drag state, held in a ref (not React state) so the window listeners read
// the latest values without re-subscribing. `active` flips true once the
// pointer crosses the threshold; before that the press is still a click.
interface DragState {
  id: string;
  title: string;
  startX: number;
  startY: number;
  active: boolean;
}

interface Ghost {
  x: number;
  y: number;
  title: string;
}

/** Which form is open, if any. Keyed on remount so field state resets between
 *  a fresh "new" and each edited ticket. */
type FormState = { mode: "create"; ticket: null } | { mode: "edit"; ticket: Ticket };

export function TicketBoard({ tickets: initialTickets, members, experiments, editable }: Props) {
  const router = useRouter();
  const [tickets, setTickets] = useState<Ticket[]>(initialTickets);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [over, setOver] = useState<TicketStatus | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);

  const dragRef = useRef<DragState | null>(null);
  // One controller per active drag; abort() removes all three window listeners
  // at once, so teardown can't half-happen and there's no listener leak.
  const listenersRef = useRef<AbortController | null>(null);
  // Latest tickets, readable from the stable window handlers without re-subscribing.
  const ticketsRef = useRef(tickets);
  useEffect(() => {
    ticketsRef.current = tickets;
  }, [tickets]);

  const dragging = ghost !== null;
  const grouped = useMemo(() => groupTicketsByStatus(tickets), [tickets]);

  const memberLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(m.userId, m.label);
    return map;
  }, [members]);
  const experimentNameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const x of experiments) map.set(x.key, x.name);
    return map;
  }, [experiments]);

  // Re-sync from the server only when the underlying data actually changes (a
  // refresh after a create/edit/delete, or a move's revalidate) — never for our
  // own optimistic move, which leaves props untouched.
  const serverSig = signature(initialTickets);
  const lastServerSig = useRef(serverSig);
  useEffect(() => {
    if (lastServerSig.current !== serverSig) {
      lastServerSig.current = serverSig;
      setTickets(initialTickets);
    }
  }, [serverSig, initialTickets]);

  // Persist a move; roll the optimistic state back to `rollback` on failure.
  const persistMove = useCallback(
    async (id: string, status: TicketStatus, position: number, rollback: Ticket[]) => {
      const res = await moveTicketAction(id, status, position);
      if (!res.ok) {
        setTickets(rollback);
        setError(res.error);
      }
    },
    [],
  );

  // The drop: optimistically move the card to the END of the target column,
  // then persist. Stable (reads the latest tickets via the ref), so the window
  // pointerup handler can call it without going stale.
  const onDrop = useCallback(
    (id: string, targetStatus: TicketStatus) => {
      const current = ticketsRef.current;
      const ticket = current.find((t) => t.id === id);
      // Only a cross-column drop moves anything (v1: no within-column reorder).
      if (!ticket || ticket.status === targetStatus) return;

      const position = endOfColumnPosition(current, targetStatus, id);
      const next = current.map((t) =>
        t.id === id ? { ...t, status: targetStatus, position } : t,
      );
      setTickets(next);
      setError(null);
      void persistMove(id, targetStatus, position, current);
    },
    [persistMove],
  );

  // Tear the current drag down: clear state and remove all window listeners at
  // once via the abort controller. Stable, referenced by every handler.
  const endDrag = useCallback(() => {
    dragRef.current = null;
    setGhost(null);
    setOver(null);
    setDraggedId(null);
    listenersRef.current?.abort();
    listenersRef.current = null;
  }, []);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) {
        return;
      }
      d.active = true;
      setDraggedId(d.id);
    }
    e.preventDefault();
    setGhost({ x: e.clientX, y: e.clientY, title: d.title });
    setOver(columnAt(e.clientX, e.clientY));
  }, []);

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) {
        endDrag();
        return;
      }
      const wasActive = d.active;
      const target = wasActive ? columnAt(e.clientX, e.clientY) : null;
      const id = d.id;
      endDrag();
      if (!wasActive) {
        // A press that never crossed the threshold — treat as a click that
        // opens the card's edit form.
        const ticket = ticketsRef.current.find((t) => t.id === id);
        if (ticket) setForm({ mode: "edit", ticket });
        return;
      }
      if (target) onDrop(id, target);
    },
    [endDrag, onDrop],
  );

  const onPointerCancel = useCallback(() => {
    endDrag();
  }, [endDrag]);

  function startPress(e: ReactPointerEvent<HTMLDivElement>, ticket: Ticket) {
    if (!editable || e.button !== 0) return;
    e.preventDefault(); // stop text selection / native image drag
    listenersRef.current?.abort(); // clear any stale drag first
    dragRef.current = {
      id: ticket.id,
      title: ticket.title,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
    const ac = new AbortController();
    listenersRef.current = ac;
    window.addEventListener("pointermove", onPointerMove, { signal: ac.signal });
    window.addEventListener("pointerup", onPointerUp, { signal: ac.signal });
    window.addEventListener("pointercancel", onPointerCancel, { signal: ac.signal });
  }

  // Safety net: drop any lingering listeners if we unmount mid-drag.
  useEffect(() => endDrag, [endDrag]);

  return (
    <div className="space-y-4">
      {editable && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setForm({ mode: "create", ticket: null })}
            className="btn-primary btn-sm"
          >
            + New ticket
          </button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {TICKET_STATUSES.map((status) => {
          const column = grouped[status];
          const isOver = dragging && over === status;
          const sectionClass = [
            "flex flex-col rounded-xl border bg-surface transition-colors",
            isOver
              ? "border-accent/70 ring-2 ring-inset ring-accent/50"
              : dragging
                ? "border-dashed border-line-strong"
                : "border-line",
          ].join(" ");
          return (
            <section
              key={status}
              data-column="1"
              data-status={status}
              aria-label={`${TICKET_STATUS_META[status].label} — ${column.length} ${
                column.length === 1 ? "ticket" : "tickets"
              }`}
              className={sectionClass}
            >
              <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
                <h2 className="font-display text-sm font-bold text-fg">
                  {TICKET_STATUS_META[status].label}
                </h2>
                <span
                  className="font-mono text-xs tabular-nums text-faint"
                  aria-live="polite"
                >
                  {column.length}
                </span>
              </header>
              <div className="flex min-h-[96px] flex-1 flex-col gap-2 p-3">
                {column.length === 0 ? (
                  <p className="flex flex-1 items-center justify-center py-6 text-center font-mono text-[11px] text-faint">
                    No tickets
                  </p>
                ) : (
                  column.map((t) => {
                    const isDragged = dragging && draggedId === t.id;
                    const assignee = t.assigneeUserId
                      ? (memberLabelById.get(t.assigneeUserId) ?? "Unknown member")
                      : null;
                    const experimentName = t.experimentKey
                      ? (experimentNameByKey.get(t.experimentKey) ?? t.experimentKey)
                      : null;
                    const cardClass = [
                      "flex flex-col gap-2 rounded-lg border border-line-strong bg-bg px-3 py-2.5 transition select-none",
                      editable
                        ? "cursor-grab hover:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                        : "",
                      isDragged ? "cursor-grabbing opacity-30" : "",
                      dragging ? "pointer-events-none" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <div
                        key={t.id}
                        role={editable ? "button" : undefined}
                        tabIndex={editable ? 0 : undefined}
                        aria-label={`Ticket: ${t.title}. ${
                          assignee ? `Assigned to ${assignee}` : "Unassigned"
                        }.${editable ? " Activate to edit." : ""}`}
                        onPointerDown={editable ? (e) => startPress(e, t) : undefined}
                        onKeyDown={
                          editable
                            ? (e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setForm({ mode: "edit", ticket: t });
                                }
                              }
                            : undefined
                        }
                        className={cardClass}
                        style={{ touchAction: editable ? "none" : undefined }}
                      >
                        <p className="text-sm font-medium leading-snug text-fg">{t.title}</p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium ${
                              assignee
                                ? "border-line-strong bg-surface text-muted"
                                : "border-line bg-surface text-faint"
                            }`}
                          >
                            {assignee ?? "Unassigned"}
                          </span>
                          {t.experimentKey && (
                            <Link
                              href={`/experiments/${t.experimentKey}`}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 font-mono text-[10px] font-medium text-accent transition-colors hover:bg-accent/20"
                              title={`Linked experiment — ${experimentName}`}
                            >
                              <span aria-hidden="true">↗</span>
                              <span className="max-w-[9rem] truncate">{experimentName}</span>
                            </Link>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>

      {/* The floating card that follows the cursor while dragging. */}
      {ghost && (
        <div
          className="pointer-events-none fixed z-50 w-[200px] rounded-lg border border-line-strong bg-raised px-3 py-2.5 opacity-95 shadow-lg"
          style={{ left: ghost.x + 12, top: ghost.y + 12 }}
        >
          <p className="line-clamp-2 text-sm font-medium leading-snug text-fg">{ghost.title}</p>
        </div>
      )}

      {error && (
        <p className="font-mono text-[11px] text-bad" role="alert">
          {error}
        </p>
      )}
      {editable ? (
        <p className="font-mono text-[11px] text-faint">
          Drag a card to another column to change its status, or open a card to edit it · saved
          for everyone
        </p>
      ) : (
        <p className="font-mono text-[11px] text-warn">
          Read-only — creating and moving cards needs editor access (or the tickets database is
          unavailable).
        </p>
      )}

      {form && (
        <TicketFormDialog
          key={form.mode === "edit" ? form.ticket.id : "new"}
          mode={form.mode}
          ticket={form.ticket}
          members={members}
          experiments={experiments}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The create / edit dialog — a Signal panel modelled on the ExperimentForm /
// ExperimentControls field + 2-step-delete patterns. Only ever opened by an
// editor (cards don't open when !editable), so it needs no read-only mode.
// ---------------------------------------------------------------------------

const inputClass =
  "rounded-lg border border-line-strong bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60";

function TicketFormDialog({
  mode,
  ticket,
  members,
  experiments,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  ticket: Ticket | null;
  members: MemberOption[];
  experiments: ExperimentOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [description, setDescription] = useState(ticket?.description ?? "");
  const [status, setStatus] = useState<TicketStatus>(ticket?.status ?? "backlog");
  const [assigneeUserId, setAssigneeUserId] = useState(ticket?.assigneeUserId ?? "");
  const [experimentKey, setExperimentKey] = useState(ticket?.experimentKey ?? "");
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const headingId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Focus the title on open; return focus to whatever opened the dialog on
  // close (the card or the "+ New ticket" button). No heavy focus-trap — the
  // panel is small, Escape / Cancel / backdrop all close it.
  useEffect(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleRef.current?.focus();
    return () => openerRef.current?.focus();
  }, []);

  const input: TicketInput = {
    title: title.trim(),
    description,
    status,
    assigneeUserId: assigneeUserId || null,
    experimentKey: experimentKey || null,
  };
  // The SAME pure validation the server runs — gates submit for instant feedback.
  const clientError =
    mode === "create" ? validateTicketInput(input) : validateTicketPatch(input);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending || clientError) return;
    setServerError(null);
    startTransition(async () => {
      let res: TicketActionResult;
      if (mode === "edit" && ticket) {
        res = await updateTicketAction(ticket.id, input);
      } else {
        res = await createTicketAction(input);
      }
      if (!res.ok) {
        setServerError(res.error);
        return;
      }
      onSaved();
    });
  }

  function onDelete() {
    if (!ticket) return;
    setServerError(null);
    startTransition(async () => {
      const res = await deleteTicketAction(ticket.id);
      if (!res.ok) {
        setServerError(res.error);
        setConfirmingDelete(false);
        return;
      }
      onSaved();
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        aria-hidden="true"
        onClick={onClose}
      />
      <form
        onSubmit={onSubmit}
        className="relative z-10 max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-xl"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 id={headingId} className="font-display text-lg font-semibold text-fg">
            {mode === "create" ? "New ticket" : "Edit ticket"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-xs text-faint transition-colors hover:text-fg"
          >
            Close
          </button>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Title</span>
          <input
            ref={titleRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={TICKET_TITLE_MAX}
            required
            spellCheck
            autoComplete="off"
            placeholder="e.g. Test £19 vs £39 on the TU recharge landing"
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={TICKET_DESCRIPTION_MAX}
            rows={4}
            placeholder="Optional — a short note, not a spec."
            className={`resize-y leading-relaxed ${inputClass}`}
          />
          <span className="self-end font-mono text-[10px] text-faint">
            {description.length}/{TICKET_DESCRIPTION_MAX}
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Status</span>
            <select
              value={status}
              onChange={(e) => {
                if (isTicketStatus(e.target.value)) setStatus(e.target.value);
              }}
              className={inputClass}
            >
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TICKET_STATUS_META[s].label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Assignee</span>
            <select
              value={assigneeUserId}
              onChange={(e) => setAssigneeUserId(e.target.value)}
              className={inputClass}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Experiment link</span>
            <select
              value={experimentKey}
              onChange={(e) => setExperimentKey(e.target.value)}
              className={inputClass}
            >
              <option value="">None</option>
              {experiments.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {serverError && (
          <p
            role="alert"
            className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad"
          >
            {serverError}
          </p>
        )}

        <div className="flex items-center justify-between gap-3 pt-1">
          <div>
            {mode === "edit" &&
              ticket &&
              (!confirmingDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={pending}
                  className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-faint transition-colors hover:border-bad/40 hover:text-bad disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Delete
                </button>
              ) : (
                <span
                  className="flex items-center gap-1.5"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setConfirmingDelete(false);
                    }
                  }}
                >
                  <button
                    type="button"
                    onClick={onDelete}
                    disabled={pending}
                    className="rounded-md border border-bad/50 bg-bad/15 px-2.5 py-1 text-xs font-medium text-bad transition-colors hover:bg-bad/25 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {pending ? "Deleting…" : "Confirm delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={pending}
                    className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </span>
              ))}
          </div>

          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={pending} className="btn-ghost btn-sm">
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || clientError !== null}
              className="btn-primary btn-sm"
            >
              {pending ? "Saving…" : mode === "create" ? "Create ticket" : "Save changes"}
            </button>
          </div>
        </div>
        {clientError && (
          <p className="text-right font-mono text-[11px] text-faint">{clientError}</p>
        )}
      </form>
    </div>
  );
}
