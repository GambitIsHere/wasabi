"use client";

// Experiments tab — every experiment (live + archived) across all orgs,
// filterable by text, kind and org. Purely a read/observability surface; the
// operator edits an experiment in its own tenant's tool, not from here.
import { useId, useMemo, useState } from "react";
import Link from "next/link";
import type { PlatformExperiment } from "@/lib/platform-types";
import { ExperimentStatusBadge, KindBadge } from "./badges";
import {
  EmptyRow,
  FIELD_CLS,
  ResultCount,
  SearchBox,
  TABLE_WRAP_CLS,
  TH_CLS,
  THEAD_ROW_CLS,
} from "./controls";

type KindFilter = "all" | "live" | "archived";

export function ExperimentsPanel({ experiments }: { experiments: PlatformExperiment[] }) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [org, setOrg] = useState("all");

  const orgOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of experiments) if (!seen.has(e.orgId)) seen.set(e.orgId, e.orgName);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [experiments]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return experiments.filter((e) => {
      if (kind !== "all" && e.kind !== kind) return false;
      if (org !== "all" && e.orgId !== org) return false;
      if (q && !`${e.name} ${e.key} ${e.business} ${e.orgName}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [experiments, query, kind, org]);

  return (
    <section aria-label="Experiments" className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchBox
          id={searchId}
          value={query}
          onChange={setQuery}
          label="Search experiments"
          placeholder="Search experiments, keys, businesses…"
        />
        <label className="sr-only" htmlFor={`${searchId}-org`}>Filter by organization</label>
        <select id={`${searchId}-org`} value={org} onChange={(e) => setOrg(e.target.value)} className={FIELD_CLS}>
          <option value="all">All organizations</option>
          {orgOptions.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor={`${searchId}-kind`}>Filter by kind</label>
        <select
          id={`${searchId}-kind`}
          value={kind}
          onChange={(e) => setKind(e.target.value as KindFilter)}
          className={FIELD_CLS}
        >
          <option value="all">Live + archived</option>
          <option value="live">Live only</option>
          <option value="archived">Archived only</option>
        </select>
        <ResultCount shown={filtered.length} total={experiments.length} />
      </div>

      <div className={TABLE_WRAP_CLS}>
        <table className="w-full min-w-[820px] border-collapse text-left text-sm">
          <thead>
            <tr className={THEAD_ROW_CLS}>
              <th scope="col" className={TH_CLS}>Experiment</th>
              <th scope="col" className={TH_CLS}>Organization</th>
              <th scope="col" className={TH_CLS}>Origin</th>
              <th scope="col" className={TH_CLS}>Status</th>
              <th scope="col" className={TH_CLS}>Goal metric</th>
              <th scope="col" className={`${TH_CLS} text-right`}>Started</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {filtered.length === 0 ? (
              <EmptyRow colSpan={6}>No experiments match your filters.</EmptyRow>
            ) : (
              filtered.map((e) => (
                <tr key={`${e.kind}:${e.key}`} className="align-top">
                  <td className="px-4 py-3">
                    <p className="font-medium text-fg">{e.name}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-faint">
                      {e.key} · {e.business}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/operator/orgs/${e.orgId}`}
                      className="text-fg outline-none transition-colors hover:text-accent focus-visible:text-accent"
                    >
                      {e.orgName}
                    </Link>
                  </td>
                  <td className="px-4 py-3"><KindBadge kind={e.kind} /></td>
                  <td className="px-4 py-3"><ExperimentStatusBadge exp={e} /></td>
                  <td className="px-4 py-3 font-mono text-[11px] text-muted">
                    {e.goalMetric ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[11px] text-faint">
                    {e.startDate ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
