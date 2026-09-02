// ============================================================================
// /ledger — the Experiment Ledger. A signed-in reference view of the VWO
// back-catalogue (37 campaigns, snapshot 2026-09-02): page, element, change,
// per-variation result and an honest re-test / stop / fix read. Static — the
// data lives in lib/ledger-data.ts, so this renders with zero I/O and sits
// behind the same sign-in gate (app/layout.tsx) as every other page.
import type { Metadata } from "next";
import { LedgerView } from "@/components/ledger/LedgerView";

export const metadata: Metadata = {
  title: "Experiment Ledger · Wasabi",
  description:
    "Every VWO experiment, pulled apart to page, element, change and result.",
};

interface Kpi {
  n: string;
  l: string;
  s: string;
  tone?: "warn" | "bad" | "good";
}

const KPIS: Kpi[] = [
  { n: "37", l: "experiments", s: "across AC · TU · PDF · AS" },
  { n: "3", l: "running now", s: "only 1 cleanly set up" },
  { n: "2", l: "formally concluded", s: "both “no winner”", tone: "warn" },
  { n: "0", l: "winners at 95%", s: "on a primary revenue goal", tone: "bad" },
  { n: "4", l: "directional wins", s: "worth a powered re-test", tone: "good" },
];

const TONE: Record<string, string> = {
  warn: "text-warn",
  bad: "text-bad",
  good: "text-good",
};

export default function LedgerPage() {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <h1 className="font-display text-2xl font-bold tracking-tight text-fg">
            Experiment Ledger
          </h1>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-faint">
            VWO · snapshot 02 Sep 2026
          </span>
        </div>
        <p className="mt-2 max-w-[64ch] text-sm text-muted">
          Every A/B and split test Sanjow has run in VWO, pulled apart to what
          actually changed — the page, the element, the result. Of 37 tests, VWO
          formally concluded 2, and none crossed 95% on a revenue goal. The value
          is the design intelligence, not the verdicts: what to re-run with real
          power, what to stop, and where the tracking is lying.
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-line sm:grid-cols-3 lg:grid-cols-5">
        {KPIS.map((k) => (
          <div key={k.l} className="border-b border-r border-line bg-surface p-4 last:border-r-0">
            <div
              className={`font-display text-3xl font-bold tabular-nums leading-none tracking-tight ${
                k.tone ? TONE[k.tone] : "text-fg"
              }`}
            >
              {k.n}
            </div>
            <div className="mt-1.5 text-xs text-muted">{k.l}</div>
            <div className="mt-0.5 text-[11px] text-faint">{k.s}</div>
          </div>
        ))}
      </div>

      {/* Read-this-first caveat */}
      <div className="flex flex-wrap items-start gap-3 rounded-xl border border-warn/30 bg-warn/10 px-4 py-3.5 text-sm text-fg">
        <span className="shrink-0 pt-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-wide text-warn">
          Read this first
        </span>
        <span className="min-w-[16rem] flex-1">
          Most tests ran 1–7 days on a few hundred visitors, against conversion
          events that fire under 8% of the time — far too little to detect
          anything. Several have the control starved to 1% traffic or a goal that
          stopped firing on the variant. Treat every number below as a{" "}
          <span className="font-semibold">direction</span>, never a decision.
        </span>
      </div>

      {/* Takeaways */}
      <div>
        <h2 className="mb-4 font-display text-lg font-bold tracking-tight text-fg">
          What the 37 tests taught us
        </h2>
        <div className="grid gap-4 lg:grid-cols-3">
          <Lane tone="good" title="Re-test with power">
            <Item head="Airline-coloured CTA on the dark check-in hero.">
              Keep the dark background, paint the “Boarding Pass” button the
              airline’s own brand colour. The recurring leader wherever data
              landed — <Up>+48%</Up> all-airlines, <Up>+87%</Up> Ryanair,{" "}
              <Up>+419%</Up> Vueling (tiny n). Never validated.
            </Item>
            <Item head="Light hero on the AS Exec Pass booking page.">
              Inverting the dark hero to light is <Up>+7.4%</Up> on thankyou at
              75% probability — running now (GP-452), 5 days left.
            </Item>
            <Item head="TU USP banner, measured mid-funnel.">
              Flat on final CVR, but <Up>+2.8%</Up> reach-payment-step at 87%.
              Worth a purchase-goal re-run.
            </Item>
          </Lane>

          <Lane tone="bad" title="Stop / deprioritise">
            <Item head="Light backgrounds on the check-in hero.">
              The light-bg variants lost across every airline they were shown on.
              The background isn’t the lever — the CTA colour is.
            </Item>
            <Item head="Trustpilot widgets.">
              Both the only two concluded tests. Homepage widget <Down>−10%</Down>{" "}
              thankyou; checkout carousel flat. No lift, real build cost.
            </Item>
            <Item head="Nylas “connect your inbox” on AC.">
              47k visitors, confirmation <Down>−10%</Down>. The one bounce “win”
              is a tracking artifact.
            </Item>
            <Item head="Higher / alternate TU billing prices.">
              39/49 and 29/19 came in flat-to-negative in every market — DE{" "}
              <Down>−18%</Down>, RO <Down>−56%</Down>. And a PDF optional phone
              field cost <Down>−22%</Down>.
            </Item>
          </Lane>

          <Lane tone="warn" title="Fix before trusting">
            <Item head="Powered like a poll, not a test.">
              The BG+CTA family ran 4–7 days on 100–900 visitors each. Pool the
              airlines and run one properly-sized test.
            </Item>
            <Item head="Starved controls.">
              Many splits set control to 1% (or 0.1%), so there’s no honest
              baseline to compare against.
            </Item>
            <Item head="Broken goal firing.">
              AC biweekly-new shows 5 conversions on 30,800 visitors; several
              split variants read 0% or 100% bounce. The instrument, not the idea.
            </Item>
            <Item head="Mid-flight changes.">
              GP-452 and PDF-biweekly both flushed data on a goal-definition
              change — restart the clock when that happens.
            </Item>
          </Lane>
        </div>
      </div>

      {/* Catalogue */}
      <div>
        <h2 className="mb-4 font-display text-lg font-bold tracking-tight text-fg">
          The catalogue
        </h2>
        <LedgerView />
      </div>

      <p className="border-t border-line pt-5 text-[13px] text-faint">
        <span className="text-muted">Method.</span> Pulled live from VWO
        (Wingify) on 2 Sep 2026 — page, injected element, per-variation
        conversion, probability-to-beat and sample size for all 37 campaigns in
        the six-month window. “Directional” means the point estimate moved but the
        test never reached VWO’s 95% winner threshold. Brands: AC — Airport
        Check-In · TU — Top Up · PDF — PDF SaaS · AS — Airport Security.
      </p>
    </div>
  );
}

function Lane({
  tone,
  title,
  children,
}: {
  tone: "good" | "bad" | "warn";
  title: string;
  children: React.ReactNode;
}) {
  const dot =
    tone === "good" ? "bg-good" : tone === "bad" ? "bg-bad" : "bg-warn";
  const text =
    tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-warn";
  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="mb-3 flex items-center gap-2.5">
        <span className={`size-2.5 rounded-sm ${dot}`} aria-hidden="true" />
        <h3 className={`font-mono text-xs font-semibold uppercase tracking-widest ${text}`}>
          {title}
        </h3>
      </div>
      <ul className="divide-y divide-line-whisper">{children}</ul>
    </div>
  );
}

function Item({ head, children }: { head: string; children: React.ReactNode }) {
  return (
    <li className="py-3 text-sm">
      <span className="font-semibold text-fg">{head}</span>{" "}
      <span className="text-muted">{children}</span>
    </li>
  );
}

function Up({ children }: { children: React.ReactNode }) {
  return <span className="font-mono font-semibold text-good">{children}</span>;
}
function Down({ children }: { children: React.ReactNode }) {
  return <span className="font-mono font-semibold text-bad">{children}</span>;
}
