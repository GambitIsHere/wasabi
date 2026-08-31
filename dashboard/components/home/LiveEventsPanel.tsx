// Cockpit "LIVE EVENTS" panel — the merged assignment + payment feed, newest
// first. Server component. Assignment rows come from the event store (live
// locally); payment rows (auth / rebill / declined) come from Metabase and are
// simply absent without it. Each kind gets a Unicode glyph (no emoji) coloured by
// outcome. Empty store → a clean placeholder.
import type { ActivityItem, ActivityKind } from "@/lib/home";

const GLYPH: Record<ActivityKind, { char: string; cls: string; label: string }> = {
  auth: { char: "✓", cls: "text-good", label: "payment authorised" },
  rebill: { char: "↻", cls: "text-info", label: "rebill collected" },
  declined: { char: "✗", cls: "text-bad", label: "declined" },
  assignment: { char: "→", cls: "text-faint", label: "assignment" },
};

/** HH:MM:SS (UTC) straight off the ISO string — deterministic, no TZ drift. */
function clock(ts: string): string {
  const t = ts.slice(11, 19);
  return /^\d{2}:\d{2}:\d{2}$/.test(t) ? t : "--:--:--";
}

/** A gentle, non-fabricated throughput read from the feed's own timestamps. */
function rateLabel(feed: ActivityItem[]): string {
  const now = Date.now();
  const within = (ms: number) =>
    feed.filter((i) => {
      const t = Date.parse(i.ts);
      return Number.isFinite(t) && t >= now - ms;
    }).length;
  const lastMin = within(60_000);
  if (lastMin > 0) return `~${lastMin} events/min`;
  const last5 = within(300_000);
  if (last5 > 0) return `~${(last5 / 5).toFixed(1)} events/min`;
  return "idle";
}

export function LiveEventsPanel({ feed }: { feed: ActivityItem[] }) {
  return (
    <section className="flex flex-col rounded-xl border border-line bg-surface">
      <header className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-fg">
          Live events
        </h2>
        <span className="font-mono text-xs text-faint">{rateLabel(feed)}</span>
      </header>
      {feed.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-faint">
          No events yet — captures will appear here.
        </p>
      ) : (
        <ul className="divide-y divide-line-whisper">
          {feed.map((item, i) => {
            const g = GLYPH[item.kind];
            return (
              <li
                key={`${item.ts}-${i}`}
                className="flex items-baseline gap-3 px-5 py-2.5"
              >
                <time className="shrink-0 font-mono text-xs tabular-nums text-faint">
                  {clock(item.ts)}
                </time>
                <span
                  aria-hidden="true"
                  className={`shrink-0 font-mono text-sm ${g.cls}`}
                >
                  {g.char}
                </span>
                <span className="sr-only">{g.label}:</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
                  {item.text}
                </span>
                {item.experimentKey && (
                  <code className="hidden shrink-0 font-mono text-[11px] text-faint sm:inline">
                    {item.experimentKey}
                  </code>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
