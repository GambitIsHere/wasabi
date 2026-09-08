"use client";

// ============================================================================
// Suggested experiments — the roadmap card list that closes the loop.
// ----------------------------------------------------------------------------
// The server (app/roadmap/page.tsx) computes the suggestions (reusing the
// backlog scan) and hands them here. This component adds the interactive tail:
//   * "+ Test" promotes a suggestion to /experiments/new prefilled.
//   * "Check readiness" asks /api/roadmap/readiness whether the arm is already
//     built in its storefront (read-only).
//   * When an arm is NOT-BUILT, an admin can file a build ticket — behind an
//     in-app confirm + a watcher (tag) picker, hitting POST
//     /api/roadmap/build-ticket. The write path is TOKEN-GATED: when it's off,
//     the button is DISABLED with a clear "YouTrack write not configured" note,
//     and everything else (surface / promote / readiness) still works.
//
// All hardcoded English — matches the tool's no-i18n convention.
// ============================================================================
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type {
  ExperimentSuggestion,
  Suggestions,
} from "@/lib/experiment-suggestions";
import type { ReadinessResult, ReadinessState } from "@/lib/variant-readiness";

interface WriteMeta {
  loaded: boolean;
  writeConfigured: boolean;
  reason: string | null;
  users: { login: string; name: string }[];
  note?: string;
}

const READINESS_PILL: Record<ReadinessState, string> = {
  built: "border-good/30 bg-good/10 text-good",
  "not-built": "border-warn/30 bg-warn/10 text-warn",
  unknown: "border-line-strong bg-bg text-faint",
};
const READINESS_LABEL: Record<ReadinessState, string> = {
  built: "Built",
  "not-built": "Not built",
  unknown: "Unknown",
};

function promoteHref(s: ExperimentSuggestion) {
  return {
    pathname: "/experiments/new",
    query: {
      business: s.promote.business,
      name: s.promote.name,
      ticket: s.promote.ticket,
      ...(s.promote.theme ? { theme: s.promote.theme } : {}),
    },
  };
}

export function SuggestedExperiments({ data }: { data: Suggestions }) {
  const [meta, setMeta] = useState<WriteMeta>({
    loaded: false,
    writeConfigured: false,
    reason: null,
    users: [],
  });

  // Load the write-path meta once (config + picker users). A non-admin or a
  // disabled write path resolves to writeConfigured:false, which simply hides /
  // disables the create affordances — the rest of the card is unaffected.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/roadmap/build-ticket", { method: "GET" });
        const body = await res.json().catch(() => ({}));
        if (!alive) return;
        setMeta({
          loaded: true,
          writeConfigured: Boolean(body?.writeConfigured),
          reason: typeof body?.reason === "string" ? body.reason : null,
          users: Array.isArray(body?.users) ? body.users : [],
          note: typeof body?.note === "string" ? body.note : undefined,
        });
      } catch {
        if (alive) setMeta((m) => ({ ...m, loaded: true }));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!data.configured) return <NotConfigured />;
  if (data.suggestions.length === 0) return null;

  return (
    <section id="suggested-experiments" className="space-y-3 scroll-mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="eyebrow">Suggested experiments</h2>
        <span className="font-mono text-xs text-faint">
          {data.suggestions.length} from the YouTrack backlog
        </span>
      </div>
      <p className="max-w-2xl text-sm text-muted">
        A/B tickets the org has already written, surfaced straight onto the runway.
        Promote one into a measured experiment, or file the build ticket its arm
        needs. Source:{" "}
        <span className="font-mono text-xs text-faint">
          {data.source === "tag-query" ? "YouTrack tag query" : "keyword heuristic"}
        </span>
        .
      </p>

      <ul className="space-y-2.5">
        {data.suggestions.map((s) => (
          <SuggestionCard key={s.ticket} suggestion={s} meta={meta} />
        ))}
      </ul>
    </section>
  );
}

function SuggestionCard({
  suggestion: s,
  meta,
}: {
  suggestion: ExperimentSuggestion;
  meta: WriteMeta;
}) {
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [watchers, setWatchers] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ ticket: string | null; url?: string; existed: boolean } | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const check = useCallback(async () => {
    if (!s.themeSlug) return;
    setChecking(true);
    setReadinessError(null);
    try {
      const res = await fetch(
        `/api/roadmap/readiness?business=${encodeURIComponent(s.business)}&slug=${encodeURIComponent(s.themeSlug)}`,
      );
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.ok) setReadiness(body.readiness as ReadinessResult);
      else setReadinessError(body?.reason ?? "Readiness check failed.");
    } catch {
      setReadinessError("Readiness check failed.");
    } finally {
      setChecking(false);
    }
  }, [s.themeSlug, s.business]);

  const submit = useCallback(async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/roadmap/build-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceTicket: s.ticket,
          business: s.business,
          experimentName: s.name,
          themeSlug: s.themeSlug,
          watchers,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.ok) {
        setCreated({ ticket: body.ticket ?? null, url: body.url, existed: Boolean(body.alreadyExisted) });
        setPanelOpen(false);
      } else {
        setCreateError(body?.reason ?? "Could not create the build ticket.");
      }
    } catch {
      setCreateError("Could not create the build ticket.");
    } finally {
      setCreating(false);
    }
  }, [s.ticket, s.business, s.name, s.themeSlug, watchers]);

  const ledgerTicket = s.buildTicket?.createdTicket ?? null;
  const isNotBuilt = readiness?.state === "not-built";

  return (
    <li className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs text-faint transition-colors hover:text-accent"
            >
              {s.ticket}
            </a>
            <span className="font-mono text-[10px] text-muted">{s.business}</span>
            {s.resolved && (
              <span className="rounded-full border border-line-strong bg-bg px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                Done
              </span>
            )}
            {s.alreadyPromoted && (
              <span className="rounded-full border border-good/30 bg-good/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-good">
                Promoted
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-fg">{s.summary}</p>
          {s.themeSlug ? (
            <p className="mt-1 font-mono text-[11px] text-faint">
              arm slug: <span className="text-muted">{s.themeSlug}</span>
            </p>
          ) : (
            <p className="mt-1 font-mono text-[11px] text-faint">
              no arm slug in the ticket — pick one on the form
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5 text-xs">
          {!s.alreadyPromoted && (
            <Link
              href={promoteHref(s)}
              className="font-medium text-faint transition-colors hover:text-accent"
              title="Spin up an experiment prefilled from this ticket"
            >
              + Test
            </Link>
          )}
          {s.themeSlug && (
            <button
              type="button"
              onClick={check}
              disabled={checking}
              className="font-medium text-faint transition-colors hover:text-accent disabled:opacity-50"
            >
              {checking ? "Checking…" : "Check readiness"}
            </button>
          )}
        </div>
      </div>

      {/* Readiness result */}
      {readinessError && (
        <p className="mt-2 text-xs text-bad">{readinessError}</p>
      )}
      {readiness && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide ${READINESS_PILL[readiness.state]}`}
          >
            {READINESS_LABEL[readiness.state]}
          </span>
          <span className="text-xs text-muted">{readiness.reason}</span>
        </div>
      )}

      {/* Already-filed build ticket (from the ledger) */}
      {ledgerTicket && !created && (
        <p className="mt-2 text-xs text-muted">
          Build ticket filed:{" "}
          <span className="font-mono text-accent">{ledgerTicket}</span>
        </p>
      )}

      {/* Create-build-ticket affordance — only for a NOT-BUILT, not-yet-filed arm */}
      {isNotBuilt && !ledgerTicket && !created && (
        <div className="mt-3 border-t border-line pt-3">
          {!meta.writeConfigured ? (
            <p className="text-xs text-faint">
              <span className="font-medium text-warn">YouTrack write not configured</span>
              {meta.reason ? ` — ${meta.reason}` : ""}
            </p>
          ) : !panelOpen ? (
            <button
              type="button"
              onClick={() => setPanelOpen(true)}
              className="rounded-md border border-warn/40 bg-warn/10 px-3 py-1 text-xs font-medium text-warn transition-colors hover:bg-warn/20"
            >
              Create build ticket
            </button>
          ) : (
            <div className="space-y-2.5">
              <p className="text-xs text-muted">
                File a front-end build ticket in <span className="font-mono">GP</span>{" "}
                (Kanban State BACKLOG, PRODUCT {s.business}, Unassigned) for arm{" "}
                <span className="font-mono text-fg">{s.themeSlug}</span>.
              </p>
              {meta.users.length > 0 && (
                <fieldset className="space-y-1.5">
                  <legend className="font-mono text-[10px] uppercase tracking-wide text-faint">
                    Add watchers (optional)
                  </legend>
                  <div className="flex flex-wrap gap-1.5">
                    {meta.users.map((u) => {
                      const on = watchers.includes(u.login);
                      return (
                        <button
                          key={u.login}
                          type="button"
                          onClick={() =>
                            setWatchers((w) =>
                              on ? w.filter((x) => x !== u.login) : [...w, u.login],
                            )
                          }
                          className={`rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                            on
                              ? "border-accent/40 bg-accent/10 text-accent"
                              : "border-line bg-bg text-muted hover:text-fg"
                          }`}
                        >
                          {u.name}
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={submit}
                  disabled={creating}
                  className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {creating ? "Filing…" : "Confirm and file"}
                </button>
                <button
                  type="button"
                  onClick={() => setPanelOpen(false)}
                  disabled={creating}
                  className="text-xs text-faint transition-colors hover:text-fg disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {createError && <p className="mt-2 text-xs text-bad">{createError}</p>}
        </div>
      )}

      {/* Create result */}
      {created && (
        <p className="mt-2 text-xs text-muted">
          {created.existed ? "Build ticket already existed: " : "Build ticket filed: "}
          {created.url ? (
            <a
              href={created.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-accent hover:underline"
            >
              {created.ticket}
            </a>
          ) : (
            <span className="font-mono text-accent">{created.ticket ?? "created"}</span>
          )}
        </p>
      )}
    </li>
  );
}

function NotConfigured() {
  return (
    <section className="space-y-3">
      <h2 className="eyebrow">Suggested experiments</h2>
      <div className="rounded-xl border border-dashed border-line-strong bg-surface px-6 py-8 text-center">
        <p className="text-sm text-muted">
          Set <code className="font-mono text-xs text-accent/90">YOUTRACK_TOKEN</code>{" "}
          and <code className="font-mono text-xs text-accent/90">YOUTRACK_HOST</code>{" "}
          to surface the A/B backlog here.
        </p>
      </div>
    </section>
  );
}
