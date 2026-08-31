// Cockpit alert banners — surfaced only when the condition is real.
//   • Guardrail (bad-tinted): a significant negative auth move on an active arm.
//     Verdict-derived, so present only when Metabase is reachable (prod).
//   • No-traffic (warn-tinted): an active experiment with zero assignments today —
//     usually storefront middleware not yet wired. Local-computable from the event
//     store, so it can show locally.
// Renders nothing when both lists are empty (the common local case).
import Link from "next/link";
import type { GuardrailFlag } from "./types";

export interface NoTrafficFlag {
  experimentKey: string;
  days: number;
}

/** How many no-traffic banners to show before collapsing the rest into a count. */
const MAX_NO_TRAFFIC = 3;

export function AlertBanners({
  guardrails,
  noTraffic,
}: {
  guardrails: GuardrailFlag[];
  noTraffic: NoTrafficFlag[];
}) {
  if (guardrails.length === 0 && noTraffic.length === 0) return null;

  const shown = noTraffic.slice(0, MAX_NO_TRAFFIC);
  const overflow = noTraffic.length - shown.length;

  return (
    <section aria-label="Alerts" className="space-y-2.5">
      {guardrails.map((g) => (
        <div
          key={`guard-${g.experimentKey}-${g.arm}`}
          role="alert"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-bad/30 bg-bad/5 px-4 py-3 text-sm"
        >
          <span
            aria-hidden="true"
            className="font-mono text-xs font-semibold text-bad"
          >
            ⚠ GUARDRAIL
          </span>
          <span className="text-fg">
            auth_rate breach on{" "}
            <code className="font-mono text-xs text-bad">{g.experimentKey}</code>{" "}
            <code className="font-mono text-xs text-faint">{g.arm}</code>
            <span className="text-muted"> — {g.detail}</span>
          </span>
          <Link
            href={`/experiments/${g.experimentKey}`}
            className="ml-auto shrink-0 font-mono text-xs text-bad underline-offset-2 hover:underline"
          >
            Guardrails →
          </Link>
        </div>
      ))}

      {shown.map((n) => (
        <div
          key={`notraffic-${n.experimentKey}`}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-warn/30 bg-warn/5 px-4 py-3 text-sm"
        >
          <span
            aria-hidden="true"
            className="font-mono text-xs font-semibold text-warn"
          >
            ◇ NO TRAFFIC
          </span>
          <span className="text-fg">
            <code className="font-mono text-xs text-warn">{n.experimentKey}</code>{" "}
            <span className="text-muted">
              active {n.days}d with zero assignments today — storefront middleware
              not wired.
            </span>
          </span>
          <Link
            href={`/experiments/${n.experimentKey}`}
            className="ml-auto shrink-0 font-mono text-xs text-warn underline-offset-2 hover:underline"
          >
            Inbox →
          </Link>
        </div>
      ))}

      {overflow > 0 && (
        <p className="px-1 font-mono text-xs text-faint">
          +{overflow} more active {overflow === 1 ? "experiment" : "experiments"}{" "}
          with no traffic today
        </p>
      )}
    </section>
  );
}
