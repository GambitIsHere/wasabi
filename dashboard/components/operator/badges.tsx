// Operator-console status pills. Server-safe (no client hooks) so both the
// client panels and the server-rendered org detail page can use them. Token-
// driven colours (light + dark handled by globals.css), mono uppercase labels —
// the same StatusPill idiom components/pills.tsx established.
import type { MembershipRole, UserStatus } from "@/lib/roles";
import {
  experimentStatus,
  type PlatformExperiment,
  type StatusTone,
} from "@/lib/platform-types";

const TONE_CLASS: Record<StatusTone, string> = {
  good: "border-good/40 bg-good/10 text-good",
  warn: "border-warn/40 bg-warn/10 text-warn",
  bad: "border-bad/40 bg-bad/10 text-bad",
  info: "border-info/40 bg-info/10 text-info",
  faint: "border-line-strong bg-surface text-muted",
};

function Pill({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${TONE_CLASS[tone]}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  );
}

const ROLE_TONE: Record<MembershipRole, StatusTone> = {
  owner: "good",
  admin: "info",
  editor: "warn",
  viewer: "faint",
};

export function RoleBadge({ role }: { role: MembershipRole }) {
  return <Pill tone={ROLE_TONE[role]}>{role}</Pill>;
}

const USER_STATUS_TONE: Record<UserStatus, StatusTone> = {
  active: "good",
  pending: "warn",
  suspended: "bad",
};

export function UserStatusBadge({ status }: { status: UserStatus }) {
  return <Pill tone={USER_STATUS_TONE[status]}>{status}</Pill>;
}

/** Live (green) vs archived (faint) origin of an experiment row. */
export function KindBadge({ kind }: { kind: PlatformExperiment["kind"] }) {
  return <Pill tone={kind === "live" ? "good" : "faint"}>{kind}</Pill>;
}

/** The experiment's status — Active/Paused for live, the stored verdict for
 *  archived. Reads its label + tone from the pure helper in platform-types. */
export function ExperimentStatusBadge({ exp }: { exp: PlatformExperiment }) {
  const { label, tone } = experimentStatus(exp);
  return <Pill tone={tone}>{label}</Pill>;
}
