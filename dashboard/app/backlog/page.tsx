import Link from "next/link";
import {
  getExperimentBacklog,
  suggestedName,
  suggestedThemeSlug,
  type Backlog,
  type BacklogTicket,
} from "@/lib/backlog";
import { BUSINESSES } from "@/lib/mgmt";

// Pulled live from YouTrack on each request (60s-cached in the lib). Behind the
// admin middleware, so ticket context stays internal.
export const dynamic = "force-dynamic";

const BUSINESS_ORDER = [...BUSINESSES] as string[];
const ACTIVE_TAB = "rounded-md bg-accent px-3 py-1 text-bg";
const IDLE_TAB = "rounded-md px-3 py-1 text-muted transition-colors hover:text-fg";

/** Group tickets by business, ordering the known businesses first. */
function groupByBusiness(tickets: BacklogTicket[]): [string, BacklogTicket[]][] {
  const map = new Map<string, BacklogTicket[]>();
  for (const t of tickets) {
    const arr = map.get(t.business) ?? [];
    arr.push(t);
    map.set(t.business, arr);
  }
  return [...map.entries()].sort((a, b) => {
    const ia = BUSINESS_ORDER.indexOf(a[0]);
    const ib = BUSINESS_ORDER.indexOf(b[0]);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a[0].localeCompare(b[0]);
  });
}

export default async function BacklogPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const showAll = view === "all";
  const backlog = await getExperimentBacklog({ open: !showAll });
  const groups = groupByBusiness(backlog.tickets);
  const openCount = backlog.tickets.filter((t) => !t.resolved).length;

  return (
    <div className="space-y-8">
      <section className="relative space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-3">
            <p className="eyebrow">From YouTrack</p>
            <h1 className="font-display text-4xl font-bold tracking-tight text-fg sm:text-5xl">
              Test <span className="serif-accent">backlog</span>
            </h1>
          </div>
          <div className="flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5 font-mono text-xs font-medium">
            <Link href="/backlog" className={!showAll ? ACTIVE_TAB : IDLE_TAB}>
              Open
            </Link>
            <Link
              href="/backlog?view=all"
              className={showAll ? ACTIVE_TAB : IDLE_TAB}
            >
              All + history
            </Link>
          </div>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          Every A/B test the org runs starts life as a YouTrack ticket — almost
          always &ldquo;create a new theme &rarr; run the split&rdquo;, which is
          exactly Wasabi&apos;s variant&rarr;
          <code className="font-mono text-xs text-accent/90">?theme=</code>{" "}
          model. This is that backlog, pulled live and tagged by business, so you
          can turn a ticket straight into a measured experiment.
        </p>
        <div
          className="h-0.5 w-28 rounded-full bg-accent"
          aria-hidden="true"
        />
      </section>

      {!backlog.configured ? (
        <NotConfigured />
      ) : backlog.tickets.length === 0 ? (
        <EmptyState showAll={showAll} />
      ) : (
        <section className="space-y-8" aria-label="Backlog by business">
          {groups.map(([business, tickets]) => (
            <div key={business} className="space-y-2.5">
              <div className="flex items-baseline gap-2">
                <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">
                  {business}
                </h2>
                <span className="font-mono text-xs tabular-nums text-accent">
                  {tickets.length}
                </span>
              </div>
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                {tickets.map((t) => (
                  <TicketRow key={t.id} t={t} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {backlog.configured && (
        <BacklogFooter backlog={backlog} openCount={openCount} />
      )}
    </div>
  );
}

function TicketRow({ t }: { t: BacklogTicket }) {
  const theme = suggestedThemeSlug(`${t.summary} ${t.description}`);
  const newHref = {
    pathname: "/experiments/new",
    query: {
      business: t.business,
      name: suggestedName(t.summary),
      ticket: t.id,
      ...(theme ? { theme } : {}),
    },
  };
  return (
    <li
      className="row-clickable flex items-start gap-3 px-4 py-3"
      title={t.description || t.summary}
    >
      <TicketStatePill resolved={t.resolved} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <a
            href={t.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-faint transition-colors hover:text-accent"
          >
            {t.id}
          </a>
          <span className="text-sm text-fg">{t.summary}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
          {t.ticketType && <span>{t.ticketType}</span>}
          {t.assignee && (
            <>
              <span aria-hidden="true">·</span>
              <span>{t.assignee}</span>
            </>
          )}
          {t.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] text-muted"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3 self-center text-xs font-medium">
        <Link
          href={newHref}
          className="text-faint transition-colors hover:text-accent"
          title="Spin up a Wasabi experiment prefilled from this ticket"
        >
          + Test
        </Link>
        <a
          href={t.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-faint transition-colors hover:text-accent"
          title="Open this ticket in YouTrack"
        >
          YouTrack &#8599;
        </a>
      </div>
    </li>
  );
}

function TicketStatePill({ resolved }: { resolved: boolean }) {
  return resolved ? (
    <span className="mt-0.5 inline-flex shrink-0 items-center rounded-full border border-line-strong bg-bg px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
      Done
    </span>
  ) : (
    <span className="mt-0.5 inline-flex shrink-0 items-center rounded-full border border-info/30 bg-info/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-info">
      Open
    </span>
  );
}

function NotConfigured() {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
      <div className="mb-3 text-3xl" aria-hidden="true">
        🎫
      </div>
      <h2 className="text-lg font-semibold text-fg">YouTrack not connected</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">
        Set <code className="font-mono text-xs text-accent/90">YOUTRACK_TOKEN</code>{" "}
        and{" "}
        <code className="font-mono text-xs text-accent/90">YOUTRACK_HOST</code> in
        the Vercel project env to pull the test backlog from YouTrack.
      </p>
    </div>
  );
}

function EmptyState({ showAll }: { showAll: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
      <h2 className="text-lg font-semibold text-fg">No testing tickets found</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">
        {showAll
          ? "The query returned nothing."
          : "Nothing open right now — try All + history."}
      </p>
    </div>
  );
}

function BacklogFooter({
  backlog,
  openCount,
}: {
  backlog: Backlog;
  openCount: number;
}) {
  return (
    <footer className="space-y-1 border-t border-line pt-4 text-xs text-faint">
      <p>
        {backlog.tickets.length} tickets · {openCount} open · source:{" "}
        <span className="font-medium text-muted">
          {backlog.source === "tag-query"
            ? "YouTrack tag query"
            : "keyword heuristic"}
        </span>{" "}
        ({backlog.query})
      </p>
      {backlog.source === "heuristic" && (
        <p>
          Heuristic until an{" "}
          <code className="font-mono">experiment</code> tag is backfilled — then
          set{" "}
          <code className="font-mono">
            YOUTRACK_BACKLOG_QUERY=&quot;tag: experiment&quot;
          </code>{" "}
          to switch to the clean source.
        </p>
      )}
    </footer>
  );
}
