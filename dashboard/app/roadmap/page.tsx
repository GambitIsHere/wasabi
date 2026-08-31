import { Fragment } from "react";
import { ROADMAP, YT, TOTAL_WEEKS, type Lane, type RoadmapTest } from "@/lib/roadmap";

// Static: the roadmap is curated in lib/roadmap.ts, not fetched.
export const dynamic = "force-static";

const LANE: Record<Lane, { text: string; bar: string; sw: string }> = {
  AC: { text: "text-info", bar: "border-info/40 bg-info/10", sw: "bg-info" },
  AS: { text: "text-amber", bar: "border-amber/40 bg-amber/10", sw: "bg-amber" },
  TU: { text: "text-sky", bar: "border-sky/40 bg-sky/10", sw: "bg-sky" },
};

const STATUS: Record<RoadmapTest["status"], { label: string; cls: string }> = {
  live: { label: "Live now", cls: "border-good/30 bg-good/10 text-good" },
  "prod-review": { label: "Prod review", cls: "border-warn/30 bg-warn/10 text-warn" },
  built: { label: "Built", cls: "border-line-strong bg-bg text-muted" },
  pending: { label: "New ticket", cls: "border-violet/30 bg-violet/10 text-violet" },
};

const weeks = Array.from({ length: TOTAL_WEEKS }, (_, i) => i + 1);
const short = (s: string) => (s.length > 26 ? s.slice(0, 25) + "…" : s);

export default function RoadmapPage() {
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
          the next. On VWO now; GP-549 doubles as the Wasabi pilot. Week&nbsp;1 = kickoff.
        </p>
      </section>

      {/* TIMELINE */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="eyebrow">The runway</h2>
          <span className="font-mono text-xs text-faint">lanes parallel · serial within a lane</span>
        </div>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface p-4">
          <div
            className="grid min-w-[760px] gap-x-1.5 gap-y-2.5"
            style={{ gridTemplateColumns: `128px repeat(${TOTAL_WEEKS}, minmax(0,1fr))` }}
          >
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

            {ROADMAP.map((lane, li) => (
              <Fragment key={lane.lane}>
                <div style={{ gridRow: li + 2, gridColumn: 1 }} className="flex flex-col justify-center pr-2">
                  <span className={`font-display text-sm font-bold ${LANE[lane.lane].text}`}>{lane.lane}</span>
                  <span className="font-mono text-[9px] text-faint">{lane.repo}</span>
                </div>
                {lane.tests.map((t) => (
                  <a
                    key={lane.lane + t.title}
                    href={t.ticket ? YT(t.ticket) : undefined}
                    target={t.ticket ? "_blank" : undefined}
                    rel="noopener noreferrer"
                    style={{ gridRow: li + 2, gridColumn: `${t.startWeek + 1} / ${t.endWeek + 2}` }}
                    className={`flex min-h-[48px] flex-col justify-center gap-0.5 rounded-lg border px-2.5 py-1.5 no-underline transition ${LANE[lane.lane].bar} ${t.ticket ? "hover:brightness-125" : ""}`}
                  >
                    <span className={`font-mono text-[11px] font-semibold ${LANE[lane.lane].text}`}>
                      {t.ticket || "new"}
                      {t.status === "live" && " · live"}
                      {t.pilot && " · pilot"}
                    </span>
                    <span className="text-[11px] leading-tight text-fg">{short(t.title)}</span>
                  </a>
                ))}
              </Fragment>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-4 font-mono text-[11px] text-muted">
          <span className="inline-flex items-center gap-1.5"><i className={`h-2.5 w-2.5 rounded-sm ${LANE.AC.sw}`} /> AC · Check-In</span>
          <span className="inline-flex items-center gap-1.5"><i className={`h-2.5 w-2.5 rounded-sm ${LANE.AS.sw}`} /> AS · Fast-Track</span>
          <span className="inline-flex items-center gap-1.5"><i className={`h-2.5 w-2.5 rounded-sm ${LANE.TU.sw}`} /> TU · Top Up</span>
        </div>
      </section>

      {/* ORDER PER LANE */}
      <section className="space-y-3">
        <h2 className="eyebrow">Order per repo</h2>
        <div className="grid gap-5 lg:grid-cols-3">
          {ROADMAP.map((lane) => (
            <div key={lane.lane} className="overflow-hidden rounded-xl border border-line bg-surface">
              <header className="flex items-center gap-2 border-b border-line px-5 py-4">
                <span className={`h-5 w-2.5 rounded-sm ${LANE[lane.lane].sw}`} />
                <span className="font-display text-base font-bold text-fg">{lane.lane} · {lane.business}</span>
              </header>
              <div className="px-5 pb-1 pt-3 font-mono text-[10px] text-faint">{lane.repo} · {lane.site}</div>
              <ol className="divide-y divide-line">
                {lane.tests.map((t, i) => (
                  <li key={t.title} className="grid grid-cols-[24px_1fr] gap-3 px-5 py-4">
                    <span className={`font-display text-base font-bold ${LANE[lane.lane].text}`}>{i + 1}</span>
                    <div className="space-y-1.5">
                      {t.ticket ? (
                        <a href={YT(t.ticket)} target="_blank" rel="noopener noreferrer" className="font-mono text-xs font-semibold text-info hover:underline">
                          {t.ticket} <span aria-hidden="true">↗</span>
                        </a>
                      ) : (
                        <span className="font-mono text-xs font-semibold text-violet">ticket in draft</span>
                      )}
                      <p className="text-sm font-medium text-fg">{t.title}</p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] text-muted">{t.surface}</span>
                        <span className="rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg">W{t.startWeek}–{t.endWeek}</span>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide ${STATUS[t.status].cls}`}>{STATUS[t.status].label}</span>
                        {t.pilot && <span className="inline-flex items-center rounded-full border border-violet/30 bg-violet/10 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-violet">Wasabi pilot</span>}
                      </div>
                      {t.note && <p className="font-mono text-[10px] text-faint">{t.note}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </section>

      <p className="border-t border-line pt-4 text-xs text-faint">
        Run each to significance or a 4-week cap · winner judged on completed bookings · then start the next in that lane. Curated in <span className="font-mono">lib/roadmap.ts</span>.
      </p>
    </div>
  );
}
