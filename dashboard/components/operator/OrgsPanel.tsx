"use client";

// Orgs tab — a filterable directory of every organization on the platform,
// each row drilling into /operator/orgs/<id>. Filters run client-side over data
// the server already resolved (this island never re-reads the DB).
import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { OrgSummary } from "@/lib/platform-types";
import { EmptyRow, ResultCount, SearchBox, TABLE_WRAP_CLS, TH_CLS, THEAD_ROW_CLS } from "./controls";

function Num({ value, muted = false }: { value: number; muted?: boolean }) {
  return (
    <span className={`font-mono tabular-nums ${muted && value === 0 ? "text-faint" : "text-fg"}`}>
      {value.toLocaleString()}
    </span>
  );
}

export function OrgsPanel({ orgs }: { orgs: OrgSummary[] }) {
  const router = useRouter();
  const searchId = useId();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orgs;
    return orgs.filter((o) =>
      `${o.name} ${o.id} ${o.verifiedDomain ?? ""}`.toLowerCase().includes(q),
    );
  }, [orgs, query]);

  return (
    <section aria-label="Organizations" className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchBox
          id={searchId}
          value={query}
          onChange={setQuery}
          label="Search organizations"
          placeholder="Search organizations, slugs, domains…"
        />
        <ResultCount shown={filtered.length} total={orgs.length} />
      </div>

      <div className={TABLE_WRAP_CLS}>
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead>
            <tr className={THEAD_ROW_CLS}>
              <th scope="col" className={TH_CLS}>Organization</th>
              <th scope="col" className={TH_CLS}>Members</th>
              <th scope="col" className={TH_CLS}>Projects</th>
              <th scope="col" className={TH_CLS}>Live tests</th>
              <th scope="col" className={TH_CLS}>Archived</th>
              <th scope="col" className={`${TH_CLS} text-right`}>Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {filtered.length === 0 ? (
              <EmptyRow colSpan={6}>No organizations match your search.</EmptyRow>
            ) : (
              filtered.map((o) => (
                <tr
                  key={o.id}
                  className="row-clickable cursor-pointer"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a")) return;
                    router.push(`/operator/orgs/${o.id}`);
                  }}
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/operator/orgs/${o.id}`}
                      className="block font-medium text-fg outline-none transition-colors hover:text-accent focus-visible:text-accent"
                    >
                      {o.name}
                    </Link>
                    <p className="mt-0.5 font-mono text-[11px] text-faint">
                      {o.id}
                      {o.verifiedDomain ? ` · ${o.verifiedDomain}` : " · no domain"}
                    </p>
                  </td>
                  <td className="px-4 py-3"><Num value={o.memberCount} muted /></td>
                  <td className="px-4 py-3"><Num value={o.projectCount} muted /></td>
                  <td className="px-4 py-3"><Num value={o.liveExperimentCount} muted /></td>
                  <td className="px-4 py-3"><Num value={o.archivedExperimentCount} muted /></td>
                  <td className="px-4 py-3 text-right font-mono text-[11px] text-faint">
                    {new Date(o.createdAt).toLocaleDateString()}
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
