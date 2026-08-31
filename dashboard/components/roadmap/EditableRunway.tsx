"use client";

// ============================================================================
// Wasabi — the editable roadmap runway (drag-and-drop timeline).
// ----------------------------------------------------------------------------
// The interactive twin of the old static runway grid. Each (lane row × week
// column) cell is a drop target; each tile is draggable. Dropping a tile onto a
// cell moves it to that lane and re-times it to start on that week, keeping the
// tile's duration (endWeek − startWeek) constant and clamping so it never runs
// past TOTAL_WEEKS. The move is applied optimistically, then POSTed to
// /api/admin/roadmap; a failed save rolls the UI back and surfaces an inline
// error. A tile still click-navigates to its detail page when it wasn't dragged.
//
// Native HTML5 drag-and-drop — no new dependency, and it maps cleanly onto the
// CSS grid that already places tiles by gridColumn = startWeek..endWeek.
//
// When `editable` is false (the DB was unreachable and the page fell back to the
// static roadmap) tiles are not draggable and a note says so — the runway still
// renders and still click-navigates.
// ============================================================================
import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
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

export function EditableRunway({
  lanes: initialLanes,
  editable,
}: {
  lanes: RoadmapLane[];
  editable: boolean;
}) {
  const router = useRouter();
  const [lanes, setLanes] = useState<RoadmapLane[]>(() => cloneLanes(initialLanes));
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [over, setOver] = useState<OverCell | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True once a drag has started on the current tile, so the trailing click that
  // some browsers fire after a drop doesn't navigate. A plain click never fires
  // dragstart, so it stays false and navigation proceeds.
  const dragOccurred = useRef(false);

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

  const dragging = draggingId !== null;

  function onDrop(targetLane: Lane, targetWeek: number, id: string) {
    setOver(null);
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
        // Same-lane move: remove then re-insert, then sort.
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
  }

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

  function navigate(test: RoadmapTest) {
    if (dragOccurred.current) {
      dragOccurred.current = false;
      return;
    }
    if (test.ticket) router.push(`/roadmap/${test.ticket}`);
  }

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

                {/* Drop-target cells — one per week. Only reactive while editable. */}
                {weeks.map((w) => {
                  const isOver =
                    over !== null && over.lane === laneId && over.week === w;
                  const cellClass = editable
                    ? `rounded-md transition-colors ${
                        isOver
                          ? "z-20 bg-accent/5 ring-2 ring-inset ring-accent"
                          : dragging
                            ? "border border-dashed border-line-strong/70"
                            : ""
                      }`
                    : "";
                  return (
                    <div
                      key={`${laneId}-cell-${w}`}
                      style={{ gridRow: li + 2, gridColumn: w + 1 }}
                      className={cellClass}
                      onDragOver={
                        editable
                          ? (e) => {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                              if (!isOver) setOver({ lane: laneId, week: w });
                            }
                          : undefined
                      }
                      onDrop={
                        editable
                          ? (e) => {
                              e.preventDefault();
                              onDrop(
                                laneId,
                                w,
                                e.dataTransfer.getData("text/plain") ||
                                  (draggingId ?? ""),
                              );
                            }
                          : undefined
                      }
                    />
                  );
                })}

                {/* Tiles — painted above the cells (later in DOM). Made click-through
                    while a drag is in flight so the cells beneath receive the drop. */}
                {(lane?.tests ?? []).map((t) => {
                  const id = roadmapTestId(t);
                  const isDragged = draggingId === id;
                  const barStyle: CSSProperties = {
                    gridRow: li + 2,
                    gridColumn: `${t.startWeek + 1} / ${t.endWeek + 2}`,
                  };
                  const barClass = [
                    "flex min-h-[48px] flex-col justify-center gap-0.5 rounded-lg border px-2.5 py-1.5 no-underline transition select-none",
                    cls.bar,
                    t.ticket ? "hover:brightness-125" : "",
                    editable ? "cursor-grab" : t.ticket ? "cursor-pointer" : "",
                    isDragged ? "cursor-grabbing opacity-40" : "",
                    dragging ? "pointer-events-none" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <div
                      key={laneId + t.title}
                      style={barStyle}
                      className={barClass}
                      draggable={editable}
                      role={t.ticket ? "link" : undefined}
                      tabIndex={t.ticket ? 0 : undefined}
                      aria-label={t.ticket ? `${t.ticket} — ${t.title}` : t.title}
                      onMouseDown={() => {
                        dragOccurred.current = false;
                      }}
                      onDragStart={
                        editable
                          ? (e) => {
                              dragOccurred.current = true;
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", id);
                              setDraggingId(id);
                            }
                          : undefined
                      }
                      onDragEnd={
                        editable
                          ? () => {
                              setDraggingId(null);
                              setOver(null);
                            }
                          : undefined
                      }
                      onClick={() => navigate(t)}
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
