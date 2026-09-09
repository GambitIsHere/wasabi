// ============================================================================
// Wasabi — per-org Tickets: the kanban board page (server component).
// ----------------------------------------------------------------------------
// Reads this workspace's tickets, its assignable members, and its experiments
// (for the optional experiment-link picker), then hands them to the client
// <TicketBoard>. Rendered per request (create/edit/move all reflect on refresh)
// and degrades gracefully: if the DB is unreachable the board renders EMPTY and
// read-only, exactly as app/roadmap/page.tsx does — a tenant whose read throws
// never sees another tenant's cards.
// ============================================================================
import { auth } from "@/auth";
import { listMembersForOrg } from "@/lib/membership";
import { roleAtLeast } from "@/lib/roles";
import { listExperiments } from "@/lib/store";
import { getCurrentOrgId } from "@/lib/tenant";
import type { Ticket } from "@/lib/tickets";
import { listTickets } from "@/lib/tickets-store";
import {
  TicketBoard,
  type ExperimentOption,
  type MemberOption,
} from "@/components/tickets/TicketBoard";

export const dynamic = "force-dynamic";

export default async function TicketsPage() {
  // editable = editor+ (mirrors app/layout.tsx and app/admin/members/page.tsx:
  // read the JWT role claim, no DB round-trip). UX only — every write
  // re-authorizes server-side via requireRole("editor") in the actions.
  const session = await auth();
  const isEditor = Boolean(session?.role && roleAtLeast(session.role, "editor"));

  // The board's rows. If the store is unreachable, fall back to an empty,
  // read-only board (never another tenant's data) — see the module comment.
  let tickets: Ticket[] = [];
  let dbReachable = true;
  try {
    tickets = await listTickets();
  } catch {
    dbReachable = false;
  }

  // Assignable members + linkable experiments for the form pickers. Best-effort:
  // a hiccup here just leaves a picker with its empty option, never breaks the
  // board.
  let members: MemberOption[] = [];
  let experiments: ExperimentOption[] = [];
  try {
    const orgId = await getCurrentOrgId();
    const [orgMembers, exps] = await Promise.all([
      listMembersForOrg(orgId),
      listExperiments(),
    ]);
    members = orgMembers.map((m) => {
      const name = m.name?.trim() ?? "";
      return { userId: m.userId, label: name.length > 0 ? name : m.email };
    });
    experiments = exps.map((e) => ({ key: e.key, name: e.name }));
  } catch {
    /* pickers degrade to just their empty option */
  }

  const editable = isEditor && dbReachable;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <p className="eyebrow">Org backlog</p>
        <h1 className="font-display text-4xl font-bold tracking-tight text-fg sm:text-5xl">
          Test <span className="serif-accent">tickets</span>
        </h1>
        <p className="max-w-2xl text-muted">
          This workspace&apos;s own kanban — every experiment idea or task it&apos;s tracking,
          from <span className="font-mono text-sm">backlog</span> through{" "}
          <span className="font-mono text-sm">shipped</span>. Drag a card to another column to
          move it; link one to an experiment to keep the plan and the run together.
        </p>
      </section>

      <TicketBoard
        tickets={tickets}
        members={members}
        experiments={experiments}
        editable={editable}
      />
    </div>
  );
}
