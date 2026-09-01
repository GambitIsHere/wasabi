"use client";

// ============================================================================
// Wasabi — the editable roadmap runway (drag-and-drop timeline).
// ----------------------------------------------------------------------------
// The interactive twin of the old static runway grid. Each (lane row × week
// column) cell is a drop target; each tile can be picked up and dragged. Drop a
// tile onto a cell to move it to that lane and re-time it to start on that week,
// keeping the tile's duration (endWeek − startWeek) constant and clamping so it
// never runs past TOTAL_WEEKS. The move is applied optimistically, then POSTed to
// /api/admin/roadmap; a failed save rolls the UI back and surfaces an inline
// error. A press without movement is treated as a click and navigates to the
// tile's detail page.
//
// POINTER-EVENT dragging (not native HTML5 drag-and-drop). Native DnD is
// unreliable here — `draggable` divs inside a CSS grid, with select-none and
// dataTransfer, often refuse to initiate (the grab cursor shows but the tile
// never lifts). Pointer events (pointerdown → window pointermove → pointerup)
// work the same for mouse and trackpad, let us render a real drag ghost, and are
// hit-tested against the cells with elementFromPoint, so the drop lands exactly
// where the cursor is. A small movement threshold separates a drag from a click.
//
// When `editable` is false (the DB was unreachable and the page fell back to the
// static roadmap) tiles are not draggable and a note says so — the runway still
// renders and still click-navigates.
// ============================================================================
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  TOTAL_WEEKS,
  LANES,
  roadmapTestId,
  type Lane,
  type RoadmapLane,
  type RoadmapTest,
} from "@/lib/roadmap";
import { LANE } from "@/lib/roadmap-format";

const weeks = Array.from({ length: TOTAL_WEEKS }, (_, i) => i + 1);
const short = (s: string) => (s.length > 26 ? s.slice(0, 25) + "…" : s);
// Pixels the pointer must travel before a press becomes a drag (below this it's
// a click). Keeps a normal tap navigating instead of nudging the tile.
const DRAG_THRESHOLD = 5;

/** Deep-ish clone (lanes + their tests) so optimistic edits never mutate props. */
function cloneLanes(lanes: RoadmapLane[]): RoadmapLane[] {
  return lanes.map((l) => ({ ...l, tests: l.tests.map((t) => ({ ...t })) }));
}

/** A signature that changes only when the server data actually changes. */
function signature(lanes: RoadmapLane[]): string {
  return lanes
    .map(
      (l) =>
        l.lane +
        ":" +
        l.tests
          .map((t) => `${roadmapTestId(t)}@${t.startWeek}-${t.endWeek}`)
          .join(","),
    )
    .join("|");
}

interface OverCell {
  lane: Lane;
  week: number;
}

// Live drag state, held in a ref (not React state) so the window listeners read
// the latest values without re-subscribing. `active` flips true once the pointer
// crosses the threshold; before that the press is still a potential click.
interface DragState {
  id: string;
  ticket: string;
  fromLane: Lane;
  label: string;
  title: string;
  startX: number;
  startY: number;
  active: boolean;
}

// What the floating ghost needs to paint itself as it follows the cursor.
interface Ghost {
  x: number;
  y: number;
  label: string;
  title: string;
  laneClass: string;
}

/** Read the (lane, week) drop cell under a viewport point, if any. */
function cellAt(x: number, y: number): OverCell | null {
  const el = document.elementFromPoint(x, y);
  const cell = el?.closest<HTMLElement>('[data-cell="1"]');
  if (!cell) return null;
  const lane = cell.dataset.lane as Lane | undefined;
  const week = Number(cell.dataset.week);
  if (!lane || !Number.isFinite(week)) return null;
  return { lane, week };
}

export function EditableRunway({
  lanes: initialLanes,
  editable,
}: {
  lanes: RoadmapLane[];
  editable: boolean;
}) {
  const router = useRouter();
  const [lanes, setLanes] = useState<RoadmapLane[]>(() => cloneLanes(initialLanes));
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [over, setOver] = useState<OverCell | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dragRef = useRef<DragState | null>(null);
  // One controller per active drag; abort() removes all three window listeners
  // at once, so teardown can't half-happen and there's no listener leak.
  const listenersRef = useRef<AbortController | null>(null);
  const dragging = ghost !== null;

  // Re-sync from the server when the underlying roadmap actually changes (e.g. a
  // navigation back to the page after someone else moved a tile). Skips when only
  // our own optimistic edit differs, by comparing a content signature.
  const serverSig = signature(initialLanes);
  const lastServerSig = useRef(serverSig);
  useEffect(() => {
    if (lastServerSig.current !== serverSig) {
      lastServerSig.current = serverSig;
      setLanes(cloneLanes(initialLanes));
    }
  }, [serverSig, initialLanes]);

  // onDrop closes over `lanes`, so keep a ref to the latest version that the
  // stable window listeners can call without going stale.
  const onDropRef = useRef<(t: Lane, w: number, id: string) => void>(() => {});

  const onDrop = useCallback(
    (targetLane: Lane, targetWeek: number, id: string) => {
      if (!id) return;

      // Locate the tile and the lane it currently sits in.
      let fromLane: Lane | null = null;
      let tile: RoadmapTest | null = null;
      for (const l of lanes) {
        const found = l.tests.find((t) => roadmapTestId(t) === id);
        if (found) {
          fromLane = l.lane;
          tile = found;
          break;
        }
      }
      if (!tile || !fromLane) return;

      const duration = tile.endWeek - tile.startWeek;
      // Keep the duration; clamp the start so the tile never runs past the board.
      const maxStart = TOTAL_WEEKS - duration;
      const newStart = Math.min(Math.max(targetWeek, 1), Math.max(maxStart, 1));
      const newEnd = newStart + duration;

      // No move — same lane, same start. Nothing to persist.
      if (fromLane === targetLane && newStart === tile.startWeek) return;

      const snapshot = cloneLanes(lanes);

      // Build the optimistic next state: pull the tile from its lane, drop the
      // re-timed copy into the target lane, then order the target lane by start
      // week and read the tile's index back as its position.
      const moved: RoadmapTest = { ...tile, startWeek: newStart, endWeek: newEnd };
      const next = lanes.map((l) => {
        if (l.lane === fromLane && l.lane === targetLane) {
          const rest = l.tests.filter((t) => roadmapTestId(t) !== id);
          return { ...l, tests: sortByWeek([...rest, moved]) };
        }
        if (l.lane === fromLane) {
          return { ...l, tests: l.tests.filter((t) => roadmapTestId(t) !== id) };
        }
        if (l.lane === targetLane) {
          return { ...l, tests: sortByWeek([...l.tests, moved]) };
        }
        return l;
      });

      const destTests = next.find((l) => l.lane === targetLane)?.tests ?? [];
      const position = destTests.findIndex((t) => roadmapTestId(t) === id);

      setLanes(next);
      setError(null);
      void persist(
        { id, lane: targetLane, startWeek: newStart, endWeek: newEnd, position },
        snapshot,
      );
    },
    [lanes],
  );
  onDropRef.current = onDrop;

  async function persist(
    body: {
      id: string;
      lane: Lane;
      startWeek: number;
      endWeek: number;
      position: number;
    },
    rollback: RoadmapLane[],
  ) {
    try {
      const res = await fetch("/api/admin/roadmap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { reason?: string }
          | null;
        setLanes(rollback);
        setError(data?.reason ?? `Save failed (${res.status}). The move was undone.`);
      }
    } catch {
      setLanes(rollback);
      setError("Could not reach the server. The move was undone.");
    }
  }

  // Tear the current drag down: clear state and remove all window listeners at
  // once via the abort controller. Stable, and referenced by every handler.
  const endDrag = useCallback(() => {
    dragRef.current = null;
    setGhost(null);
    setOver(null);
    listenersRef.current?.abort();
    listenersRef.current = null;
  }, []);

  // Stable window handlers — added on pointerdown, torn down by endDrag.
  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) {
        return;
      }
      d.active = true;
    }
    e.preventDefault();
    setGhost({
      x: e.clientX,
      y: e.clientY,
      label: d.label,
      title: d.title,
      laneClass: LANE[d.fromLane].bar,
    });
    setOver(cellAt(e.clientX, e.clientY));
  }, []);

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) {
        endDrag();
        return;
      }
      const wasActive = d.active;
      const target = wasActive ? cellAt(e.clientX, e.clientY) : null;
      const ticket = d.ticket;
      const id = d.id;
      endDrag();
      if (!wasActive) {
        // A press that never crossed the threshold — treat as a click.
        if (ticket) router.push(`/roadmap/${ticket}`);
        return;
      }
      if (target) onDropRef.current(target.lane, target.week, id);
    },
    [endDrag, router],
  );

  const onPointerCancel = useCallback(() => {
    endDrag();
  }, [endDrag]);

  function startPress(e: ReactPointerEvent<HTMLDivElement>, lane: Lane, t: RoadmapTest) {
    if (!editable || e.button !== 0) return;
    e.preventDefault(); // stop text selection / native image drag
    listenersRef.current?.abort(); // clear any stale drag first
    dragRef.current = {
      id: roadmapTestId(t),
      ticket: t.ticket,
      fromLane: lane,
      label:
        (t.ticket || "new") +
        (t.status === "live" ? " · live" : "") +
        (t.pilot ? " · pilot" : "") +
        (t.rerunOf ? " · ↩" : ""),
      title: short(t.title),
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
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-line bg-surface p-4">
        <div
          className="grid min-w-[760px] gap-x-1.5 gap-y-2.5"
          style={{
            gridTemplateColumns: `128px repeat(${TOTAL_WEEKS}, minmax(0,1fr))`,
          }}
        >
          {/* Week header */}
          <div style={{ gridRow: 1, gridColumn: 1 }} />
          {weeks.map((w) => (
            <div
              key={w}
              style={{ gridRow: 1, gridColumn: w + 1 }}
              className="border-b border-line pb-1 text-center font-mono text-[10px] text-faint"
            >
              W{w}
            </div>
          ))}

          {LANES.map((laneId, li) => {
            const lane = lanes.find((l) => l.lane === laneId);
            const cls = LANE[laneId];
            return (
              <Fragment key={laneId}>
                {/* Lane label */}
                <div
                  style={{ gridRow: li + 2, gridColumn: 1 }}
                  className="flex flex-col justify-center pr-2"
                >
                  <span className={`font-display text-sm font-bold ${cls.text}`}>
                    {laneId}
                  </span>
                  <span className="font-mono text-[9px] text-faint">
                    {lane?.repo}
                  </span>
                </div>

                {/* Drop-target cells — one per week, hit-tested by elementFromPoint. */}
                {weeks.map((w) => {
                  const isOver =
                    over !== null && over.lane === laneId && over.week === w;
                  const cellClass = editable
                    ? `rounded-md transition-colors ${
                        isOver
                          ? "bg-accent/5 ring-2 ring-inset ring-accent"
                          : dragging
                            ? "border border-dashed border-line-strong/70"
                            : ""
                      }`
                    : "";
                  return (
                    <div
                      key={`${laneId}-cell-${w}`}
                      data-cell="1"
                      data-lane={laneId}
                      data-week={w}
                      style={{ gridRow: li + 2, gridColumn: w + 1 }}
                      className={cellClass}
                    />
                  );
                })}

                {/* Tiles — painted above the cells (later in DOM). Made click-through
                    while a drag is in flight so elementFromPoint sees the cell beneath. */}
                {(lane?.tests ?? []).map((t) => {
                  const id = roadmapTestId(t);
                  const isDragged = dragging && dragRef.current?.id === id;
                  const barStyle: CSSProperties = {
                    gridRow: li + 2,
                    gridColumn: `${t.startWeek + 1} / ${t.endWeek + 2}`,
                    touchAction: editable ? "none" : undefined,
                  };
                  const barClass = [
                    "flex min-h-[48px] flex-col justify-center gap-0.5 rounded-lg border px-2.5 py-1.5 no-underline transition select-none",
                    cls.bar,
                    t.ticket ? "hover:brightness-125" : "",
                    editable ? "cursor-grab" : t.ticket ? "cursor-pointer" : "",
                    isDragged ? "cursor-grabbing opacity-30" : "",
                    dragging ? "pointer-events-none" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <div
                      key={laneId + t.title}
                      style={barStyle}
                      className={barClass}
                      role={t.ticket ? "link" : undefined}
                      tabIndex={t.ticket ? 0 : undefined}
                      aria-label={t.ticket ? `${t.ticket} — ${t.title}` : t.title}
                      onPointerDown={(e) => startPress(e, laneId, t)}
                      onKeyDown={
                        t.ticket
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                router.push(`/roadmap/${t.ticket}`);
                              }
                            }
                          : undefined
                      }
                    >
                      <span
                        className={`font-mono text-[11px] font-semibold ${cls.text}`}
                      >
                        {t.ticket || "new"}
                        {t.status === "live" && " · live"}
                        {t.pilot && " · pilot"}
                        {t.rerunOf && " · ↩"}
                      </span>
                      <span className="text-[11px] leading-tight text-fg">
                        {short(t.title)}
                      </span>
                    </div>
                  );
                })}
              </Fragment>
            );
          })}
        </div>
      </div>

      {/* The floating tile that follows the cursor while dragging. */}
      {ghost && (
        <div
          className={`pointer-events-none fixed z-50 flex min-h-[44px] w-[180px] flex-col justify-center gap-0.5 rounded-lg border px-2.5 py-1.5 opacity-95 shadow-lg ${ghost.laneClass}`}
          style={{ left: ghost.x + 12, top: ghost.y + 12 }}
        >
          <span className="font-mono text-[11px] font-semibold">{ghost.label}</span>
          <span className="text-[11px] leading-tight text-fg">{ghost.title}</span>
        </div>
      )}

      {error && (
        <p className="font-mono text-[11px] text-bad" role="alert">
          {error}
        </p>
      )}
      {editable ? (
        <p className="font-mono text-[11px] text-faint">
          Drag a tile to a week or another lane to re-plan · saved for everyone
        </p>
      ) : (
        <p className="font-mono text-[11px] text-warn">
          Read-only — the roadmap database is unreachable, so dragging is disabled.
        </p>
      )}
    </div>
  );
}

/** Order a lane's tests left-to-right on the runway (start week, then end). */
function sortByWeek(tests: RoadmapTest[]): RoadmapTest[] {
  return [...tests].sort(
    (a, b) => a.startWeek - b.startWeek || a.endWeek - b.endWeek,
  );
}
