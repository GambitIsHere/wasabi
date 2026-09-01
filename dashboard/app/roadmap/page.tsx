import Link from "next/link";
import { ROADMAP, type RoadmapLane } from "@/lib/roadmap";
import { listRoadmap } from "@/lib/roadmap-store";
import { reconcileRoadmapMetadata } from "@/lib/roadmap-reconcile";
import { LANE } from "@/lib/roadmap-format";
import { EditableRunway } from "@/components/roadmap/EditableRunway";
import {
  TESTED_ELEMENTS,
  VERDICTS,
  VERDICT_META,
  type Verdict,
} from "@/lib/tested-elements";
import { listArchived } from "@/lib/archive";

// The roadmap is now DB-backed (lib/roadmap-store.ts) so drag-and-drop edits
// persist; the re-run captions and the tested-elements table also deep-link into
// the archive by `key`, known only from the DB. So render per request and degrade
// gracefully if the DB is down: fall back to the static ROADMAP and turn dragging
// off. Same posture as /archive.
export const dynamic = "force-dynamic";

// Verdict → pill classes. settled = bad, retest = warn, broken = info, unread = faint.
const VERDICT_CLS: Record<Verdict, string> = {
  "settled-negative": "border-bad/30 bg-bad/10 text-bad",
  "inconclusive-retest": "border-warn/30 bg-warn/10 text-warn",
  "broken-rerun": "border-info/30 bg-info/10 text-info",
  unread: "border-line-strong bg-bg text-faint",
};

export default async function RoadmapPage() {
  // Sync the static ROADMAP's metadata (pilot badge, titles, notes) onto the DB
  // rows before reading — so a code-side change like moving the Wasabi-pilot
  // badge to GP-603 + GP-600 shows up without a reseed. Best-effort; never throws.
  await reconcileRoadmapMetadata();

  // The editable runway reads from the DB store; if that's unreachable, render
  // the static ROADMAP read-only (dragging disabled) so the page never breaks.
  let lanes: RoadmapLane[];
  let editable: boolean;
  try {
    lanes = await listRoadmap();
    editable = true;
  } catch {
    lanes = ROADMAP;
    editable = false;
  }

  // Resolve archive campaign sourceId → archive `key` for deep links. A plain
  // object (not a Map) so it can cross the server→client boundary into the runway
  // for the order-per-repo "re-run of #…" links. Falls back to the archive index
  // when the DB isn't reachable at request time.
  const keyBySourceId: Record<string, string> = {};
  try {
    for (const a of await listArchived()) {
      if (a.sourceId) keyBySourceId[a.sourceId] = a.key;
    }
  } catch {
    /* DB down — captions link to /archive instead of a specific run. */
  }
  const archiveHref = (sourceId: string) =>
    keyBySourceId[sourceId] ? `/archive/${keyBySourceId[sourceId]}` : "/archive";

  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <p className="eyebrow">Planned run</p>
        <h1 className="font-display text-4xl font-bold tracking-tight text-fg sm:text-5xl">
          Test <span className="serif-accent">roadmap</span>
        </h1>
        <p className="max-w-2xl text-muted">
          Every experiment we&apos;ve committed to run, as parallel lanes on a shared clock.
          Lanes never interfere; inside a lane, one test at a time — ship the winner, start
          the next. On VWO now; GP-603 and GP-600 are the first tests running on Wasabi
          itself — the pilot. Week&nbsp;1 = kickoff.
        </p>
      </section>

      {/* The runway (drag-and-drop), the tested-elements table (passed as children,
          rendered between), and the order-per-repo list all live inside
          EditableRunway so the per-repo order re-sorts live the instant a tile is
          dropped — same client state, no reload. */}
      <EditableRunway
        lanes={lanes}
        editable={editable}
        archiveKeyBySourceId={keyBySourceId}
      >
      {/* TESTED ELEMENTS — the "don't re-test a settled lever" reference. */}
      <section id="tested-elements" className="space-y-3 scroll-mt-6">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="eyebrow">Already settled</h2>
          <span className="font-mono text-xs text-faint">what the archive rules in — and out</span>
        </div>
        <p className="max-w-2xl text-sm text-muted">
          Levers we&apos;ve already put in front of traffic. A settled loss stays off the plan;
          an inconclusive or broken run earns a clean re-run. Keyed to the{" "}
          <Link href="/archive" className="text-info hover:underline">archive</Link> by VWO campaign.
        </p>

        {/* Legend */}
        <div className="flex flex-wrap gap-2.5">
          {VERDICTS.map((v) => (
            <span
              key={v}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] ${VERDICT_CLS[v]}`}
            >
              <span className="font-semibold uppercase tracking-wide">{VERDICT_META[v].label}</span>
              <span className="opacity-70">{VERDICT_META[v].blurb}</span>
            </span>
          ))}
        </div>

        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wide text-faint">
                <th className="px-5 py-2.5 font-medium">Lever</th>
                <th className="px-3 py-2.5 font-medium">Where</th>
                <th className="px-3 py-2.5 font-medium">Verdict</th>
                <th className="px-3 py-2.5 font-medium">Takeaway</th>
                <th className="px-5 py-2.5 text-right font-medium">Runs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {TESTED_ELEMENTS.map((el) => (
                <tr key={el.id} className="align-top">
                  <td className="px-5 py-3">
                    <span className="font-medium text-fg">{el.lever}</span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {el.lane ? (
                        <span className={`font-mono text-[11px] font-bold ${LANE[el.lane].text}`}>{el.lane}</span>
                      ) : (
                        <span className="font-mono text-[11px] text-faint">—</span>
                      )}
                      <span className="font-mono text-[10px] text-muted">{el.business}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide ${VERDICT_CLS[el.verdict]}`}
                    >
                      {VERDICT_META[el.verdict].label}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-muted">{el.takeaway}</td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {el.sourceIds.map((sid) => (
                        <Link
                          key={sid}
                          href={archiveHref(sid)}
                          className="rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] text-info transition-colors hover:text-accent"
                        >
                          #{sid}
                        </Link>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      </EditableRunway>

      <p className="border-t border-line pt-4 text-xs text-faint">
        Run each to significance or a 4-week cap · winner judged on completed bookings · then start the next in that lane. Curated in <span className="font-mono">lib/roadmap.ts</span>; levers + verdicts in <span className="font-mono">lib/tested-elements.ts</span>.
      </p>
    </div>
  );
}
