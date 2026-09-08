"use client";

// Members tab — every (user, org) membership across the platform, filterable by
// text, role and org. Cross-org, so the org is a column on every row.
import { useId, useMemo, useState } from "react";
import Link from "next/link";
import type { PlatformMember } from "@/lib/platform-types";
import { MEMBERSHIP_ROLES } from "@/lib/roles";
import { RoleBadge, UserStatusBadge } from "./badges";
import {
  EmptyRow,
  FIELD_CLS,
  ResultCount,
  SearchBox,
  TABLE_WRAP_CLS,
  TH_CLS,
  THEAD_ROW_CLS,
} from "./controls";

export function MembersPanel({ members }: { members: PlatformMember[] }) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("all");
  const [org, setOrg] = useState("all");

  const orgOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of members) if (!seen.has(m.orgId)) seen.set(m.orgId, m.orgName);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [members]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members.filter((m) => {
      if (role !== "all" && m.role !== role) return false;
      if (org !== "all" && m.orgId !== org) return false;
      if (q && !`${m.name ?? ""} ${m.email} ${m.orgName}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [members, query, role, org]);

  return (
    <section aria-label="Members" className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchBox
          id={searchId}
          value={query}
          onChange={setQuery}
          label="Search members"
          placeholder="Search people, emails, orgs…"
        />
        <label className="sr-only" htmlFor={`${searchId}-org`}>Filter by organization</label>
        <select id={`${searchId}-org`} value={org} onChange={(e) => setOrg(e.target.value)} className={FIELD_CLS}>
          <option value="all">All organizations</option>
          {orgOptions.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor={`${searchId}-role`}>Filter by role</label>
        <select id={`${searchId}-role`} value={role} onChange={(e) => setRole(e.target.value)} className={FIELD_CLS}>
          <option value="all">All roles</option>
          {MEMBERSHIP_ROLES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <ResultCount shown={filtered.length} total={members.length} />
      </div>

      <div className={TABLE_WRAP_CLS}>
        <table className="w-full min-w-[760px] border-collapse text-left text-sm">
          <thead>
            <tr className={THEAD_ROW_CLS}>
              <th scope="col" className={TH_CLS}>Person</th>
              <th scope="col" className={TH_CLS}>Organization</th>
              <th scope="col" className={TH_CLS}>Role</th>
              <th scope="col" className={TH_CLS}>Account</th>
              <th scope="col" className={`${TH_CLS} text-right`}>Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {filtered.length === 0 ? (
              <EmptyRow colSpan={5}>No members match your filters.</EmptyRow>
            ) : (
              filtered.map((m) => (
                <tr key={`${m.orgId}:${m.userId}`}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-fg">{m.name ?? m.email}</p>
                    {m.name && <p className="mt-0.5 font-mono text-[11px] text-faint">{m.email}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/operator/orgs/${m.orgId}`}
                      className="text-fg outline-none transition-colors hover:text-accent focus-visible:text-accent"
                    >
                      {m.orgName}
                    </Link>
                    <p className="mt-0.5 font-mono text-[11px] text-faint">{m.orgId}</p>
                  </td>
                  <td className="px-4 py-3"><RoleBadge role={m.role} /></td>
                  <td className="px-4 py-3"><UserStatusBadge status={m.userStatus} /></td>
                  <td className="px-4 py-3 text-right font-mono text-[11px] text-faint">
                    {new Date(m.joinedAt).toLocaleDateString()}
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
