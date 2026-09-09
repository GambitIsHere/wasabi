"use client";

// ============================================================================
// SampleSizeCalculator — the PLAN-side helper on the New experiment page.
// ----------------------------------------------------------------------------
// A standalone planning aid: given a baseline conversion rate, the effect you
// want to detect, your confidence/power, and your traffic, it shows the sample
// each arm needs, the total, and how long that takes. It is DELIBERATELY
// rendered as a sibling of ExperimentForm (never inside its <form>) so it
// shares no state with experiment creation and cannot affect assignment,
// capture, or the saved config — it only reads the numbers you type here.
//
// All the math is lib/ab-stats.ts (the shared engine). This component is just
// controlled inputs + a live-computed readout; it holds no statistics of its
// own. Styling composes the same globals.css tokens/utilities ExperimentForm
// uses (cards, inputs, accent) — no new fonts, no new deps.
// ============================================================================
import { useMemo, useState } from "react";
import {
  estimateDuration,
  sampleSizePerArm,
  type SampleSizeOpts,
} from "@/lib/ab-stats";

/** Parse a percent-style text field to a proportion (12.5 → 0.125). NaN/empty
 *  → null so the readout can show a prompt rather than a wrong number. */
function pctToProportion(text: string): number | null {
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? n / 100 : null;
}
function toNumber(text: string): number | null {
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? n : null;
}

/** Whole-number formatter with thousands separators. */
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-GB");
}

const inputClass =
  "rounded-lg border border-line-strong bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40";
const fieldLabel = "text-xs font-medium text-muted";
const hint = "text-[11px] text-faint";

export function SampleSizeCalculator() {
  // Everything is kept as text so a field can be transiently empty while typing.
  const [baseline, setBaseline] = useState("5"); // % conversion rate
  const [mde, setMde] = useState("10"); // % (relative) or pp (absolute)
  const [mdeType, setMdeType] = useState<"relative" | "absolute">("relative");
  const [confidence, setConfidence] = useState("95"); // %
  const [power, setPower] = useState("80"); // %
  const [sides, setSides] = useState<1 | 2>(2);
  const [arms, setArms] = useState("2");
  const [dailyTraffic, setDailyTraffic] = useState("1000");
  const [allocation, setAllocation] = useState("100"); // % of traffic into the test

  const result = useMemo(() => {
    const p1 = pctToProportion(baseline);
    const mdeVal = pctToProportion(mde);
    const conf = pctToProportion(confidence);
    const pow = pctToProportion(power);
    const variants = toNumber(arms);
    const traffic = toNumber(dailyTraffic);
    const alloc = pctToProportion(allocation);

    // Missing required inputs → no readout yet (not a zero, not an error).
    if (p1 === null || mdeVal === null || conf === null || pow === null) {
      return { state: "incomplete" as const };
    }

    const opts: SampleSizeOpts = {
      baselineRate: p1,
      mde: mdeVal,
      mdeType,
      alpha: 1 - conf,
      power: pow,
      sides,
    };
    const nPerArm = sampleSizePerArm(opts);

    if (!Number.isFinite(nPerArm)) {
      return { state: "unsizeable" as const };
    }

    const variantCount = variants && variants >= 2 ? Math.round(variants) : 2;
    const total = nPerArm * variantCount;

    // Duration is optional — only computed when traffic is supplied.
    let duration: { days: number; weeks: number } | null = null;
    if (traffic !== null && alloc !== null) {
      duration = estimateDuration({
        nPerArm,
        variants: variantCount,
        dailyTraffic: traffic,
        allocation: alloc,
      });
    }

    return { state: "ok" as const, nPerArm, total, variantCount, duration };
  }, [baseline, mde, mdeType, confidence, power, sides, arms, dailyTraffic, allocation]);

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <h2 className="font-display text-sm font-semibold text-fg">
        Sample size &amp; duration
      </h2>
      <p className="mt-0.5 text-xs text-faint">
        Plan the test before you launch it. Nothing here is saved — it only sizes
        the experiment from the numbers you type.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {/* Baseline */}
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Baseline conversion rate</span>
          <div className="relative">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step="any"
              value={baseline}
              onChange={(e) => setBaseline(e.target.value)}
              className={`w-full pr-7 text-right font-mono tabular-nums ${inputClass}`}
              aria-label="Baseline conversion rate, percent"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-faint">
              %
            </span>
          </div>
          <span className={hint}>Control&apos;s current rate on the goal event.</span>
        </label>

        {/* MDE + type */}
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Minimum detectable effect</span>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={mde}
                onChange={(e) => setMde(e.target.value)}
                className={`w-full pr-7 text-right font-mono tabular-nums ${inputClass}`}
                aria-label="Minimum detectable effect"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-faint">
                {mdeType === "relative" ? "%" : "pp"}
              </span>
            </div>
            <select
              value={mdeType}
              onChange={(e) => setMdeType(e.target.value as "relative" | "absolute")}
              className={inputClass}
              aria-label="MDE type"
            >
              <option value="relative">relative</option>
              <option value="absolute">absolute</option>
            </select>
          </div>
          <span className={hint}>
            {mdeType === "relative"
              ? "Percent of the baseline (10% of a 5% rate → target 5.5%)."
              : "Percentage points added to the baseline (2pp → target 7%)."}
          </span>
        </label>

        {/* Confidence */}
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Confidence</span>
          <div className="relative">
            <input
              type="number"
              inputMode="decimal"
              min={50}
              max={99.99}
              step="any"
              value={confidence}
              onChange={(e) => setConfidence(e.target.value)}
              className={`w-full pr-7 text-right font-mono tabular-nums ${inputClass}`}
              aria-label="Confidence level, percent"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-faint">
              %
            </span>
          </div>
          <span className={hint}>95% is the usual bar (α = 0.05).</span>
        </label>

        {/* Power */}
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Statistical power</span>
          <div className="relative">
            <input
              type="number"
              inputMode="decimal"
              min={50}
              max={99.99}
              step="any"
              value={power}
              onChange={(e) => setPower(e.target.value)}
              className={`w-full pr-7 text-right font-mono tabular-nums ${inputClass}`}
              aria-label="Statistical power, percent"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-faint">
              %
            </span>
          </div>
          <span className={hint}>Chance of catching a real effect. 80% is standard.</span>
        </label>

        {/* Arms */}
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Number of arms</span>
          <input
            type="number"
            inputMode="numeric"
            min={2}
            step={1}
            value={arms}
            onChange={(e) => setArms(e.target.value)}
            className={`w-full text-right font-mono tabular-nums ${inputClass}`}
            aria-label="Number of arms including control"
          />
          <span className={hint}>Including control. Drives the total and the timeline.</span>
        </label>

        {/* Test direction */}
        <div className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Test direction</span>
          <div role="radiogroup" aria-label="Test direction" className="grid grid-cols-2 gap-2">
            <DirectionOption selected={sides === 2} onSelect={() => setSides(2)} label="Two-sided" />
            <DirectionOption selected={sides === 1} onSelect={() => setSides(1)} label="One-sided" />
          </div>
          <span className={hint}>Two-sided detects a move either way; one-sided needs less.</span>
        </div>

        {/* Daily traffic */}
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Daily traffic</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={dailyTraffic}
            onChange={(e) => setDailyTraffic(e.target.value)}
            className={`w-full text-right font-mono tabular-nums ${inputClass}`}
            aria-label="Daily visitors to the property"
          />
          <span className={hint}>Visitors per day the property sees. Optional — powers the timeline.</span>
        </label>

        {/* Allocation */}
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Traffic into the test</span>
          <div className="relative">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step="any"
              value={allocation}
              onChange={(e) => setAllocation(e.target.value)}
              className={`w-full pr-7 text-right font-mono tabular-nums ${inputClass}`}
              aria-label="Share of traffic routed into the test, percent"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-faint">
              %
            </span>
          </div>
          <span className={hint}>Share of daily traffic routed into the experiment.</span>
        </label>
      </div>

      {/* Readout */}
      <div className="mt-5 rounded-lg border border-line bg-bg/50 p-4" aria-live="polite">
        {result.state === "incomplete" && (
          <p className="text-sm text-muted">
            Enter a baseline rate, an effect to detect, confidence and power to size the test.
          </p>
        )}

        {result.state === "unsizeable" && (
          <p className="text-sm text-warn">
            Not sizeable with these inputs. Check that the baseline is between 0 and 100%, the effect
            is non-zero, and the target rate it implies stays under 100%.
          </p>
        )}

        {result.state === "ok" && (
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Sample per arm" value={fmtInt(result.nPerArm)} unit="visitors" />
            <Stat
              label={`Total (${result.variantCount} arms)`}
              value={fmtInt(result.total)}
              unit="visitors"
            />
            <Stat
              label="Estimated duration"
              value={
                result.duration && Number.isFinite(result.duration.days)
                  ? fmtInt(result.duration.days)
                  : "—"
              }
              unit={
                result.duration && Number.isFinite(result.duration.days)
                  ? `days (~${result.duration.weeks} wk)`
                  : "add daily traffic"
              }
            />
          </div>
        )}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-faint">
        Two-proportion normal approximation, no continuity correction — the same numeric core the
        results page uses. Duration assumes even traffic across arms and is a floor, not a promise:
        run at least one full business cycle to smooth day-of-week effects.
      </p>
    </section>
  );
}

/** One selectable direction card (radio semantics), mirroring ExperimentForm. */
function DirectionOption({
  selected,
  onSelect,
  label,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
        selected
          ? "border-accent/50 bg-accent/10 text-fg"
          : "border-line-strong bg-bg text-muted hover:border-accent/30"
      }`}
    >
      {label}
    </button>
  );
}

/** One number in the readout: a big accent figure with a label + unit. */
function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-faint">{label}</span>
      <span className="font-mono text-2xl font-semibold tabular-nums text-accent">{value}</span>
      <span className="text-[11px] text-muted">{unit}</span>
    </div>
  );
}
