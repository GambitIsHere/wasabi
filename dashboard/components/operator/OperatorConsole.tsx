"use client";

// The Sanjow operator console shell — a tabbed cross-org backoffice modelled on
// online-visa-ai's AdminTabs (a tab bar + one panel at a time), rendered with
// Wasabi's own Signal tokens. All data is resolved on the server (behind
// requireSuperAdmin) and passed in as props; this island only switches tabs and
// runs the per-panel client-side filters. The active tab is mirrored to the URL
// hash so a reload / shared link / the org-detail "back" link reopens the same
// tab — read via useSyncExternalStore (the hydration-safe way to derive client
// state from the URL, with no setState-in-effect).
import { useSyncExternalStore } from "react";
import type {
  OrgSummary,
  PlatformExperiment,
  PlatformMember,
  PlatformOverview,
} from "@/lib/platform-types";
import { OverviewPanel } from "./OverviewPanel";
import { OrgsPanel } from "./OrgsPanel";
import { MembersPanel } from "./MembersPanel";
import { ExperimentsPanel } from "./ExperimentsPanel";

type TabId = "overview" | "orgs" | "members" | "experiments";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "orgs", label: "Orgs" },
  { id: "members", label: "Members" },
  { id: "experiments", label: "Experiments" },
];

function isTabId(value: string): value is TabId {
  return TABS.some((t) => t.id === value);
}

// The URL hash IS the tab store. useSyncExternalStore reads it the
// hydration-safe way: getServerSnapshot pins "overview" for SSR + the first
// client render, then the client subscribes to hashchange. Nothing calls
// setState in an effect.
function subscribeHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function readHashTab(): TabId {
  const fromHash = window.location.hash.replace(/^#/, "");
  return isTabId(fromHash) ? fromHash : "overview";
}

function serverTab(): TabId {
  return "overview";
}

export function OperatorConsole({
  overview,
  orgs,
  members,
  experiments,
}: {
  overview: PlatformOverview;
  orgs: OrgSummary[];
  members: PlatformMember[];
  experiments: PlatformExperiment[];
}) {
  const tab = useSyncExternalStore(subscribeHash, readHashTab, serverTab);

  const select = (next: TabId) => {
    // replaceState keeps the back button uncluttered; the manual event tells
    // useSyncExternalStore to re-read (replaceState alone doesn't fire hashchange).
    history.replaceState(null, "", `#${next}`);
    window.dispatchEvent(new Event("hashchange"));
  };

  const counts: Record<TabId, number | null> = {
    overview: null,
    orgs: orgs.length,
    members: members.length,
    experiments: experiments.length,
  };

  return (
    <div className="space-y-6">
      <nav
        aria-label="Operator sections"
        className="flex flex-wrap gap-1 border-b border-line"
      >
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => select(t.id)}
              aria-current={active ? "page" : undefined}
              className={`relative rounded-t-md px-3.5 py-2 text-sm transition-colors ${
                active ? "text-fg" : "text-muted hover:text-accent"
              }`}
            >
              {t.label}
              {counts[t.id] !== null && (
                <span className="ml-1.5 font-mono text-[11px] tabular-nums text-faint">
                  {counts[t.id]}
                </span>
              )}
              {active && (
                <span
                  className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-accent"
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </nav>

      {tab === "overview" && <OverviewPanel overview={overview} orgs={orgs} />}
      {tab === "orgs" && <OrgsPanel orgs={orgs} />}
      {tab === "members" && <MembersPanel members={members} />}
      {tab === "experiments" && <ExperimentsPanel experiments={experiments} />}
    </div>
  );
}
