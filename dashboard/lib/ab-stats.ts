// ============================================================================
// A/B PLANNING statistics — sample size, duration, SRM, P(beat control).
// ----------------------------------------------------------------------------
// This is the PLAN half of the calculator. The READ half already exists and is
// not duplicated here: lib/verdict.ts owns significance after the fact
// (twoProportionZTest, welchTTest, buildVerdict) and this module imports its
// primitives rather than reimplementing them, so the tool keeps ONE numeric
// core. If the arithmetic in verdict.ts is ever corrected, these functions
// inherit the correction.
//
// PURE: no DOM, no I/O, no dependencies beyond verdict.ts. Every function is a
// deterministic transform of its inputs, so it runs identically in the tool,
// in a marketing-site bundle, and in a test.
//
// FREQUENTIST, deliberately. Sample size and power are the questions a team
// actually asks before a test ("how long must this run?"), and the answer has
// to match the test that will later be applied — which is the pooled
// two-proportion z-test in verdict.ts. probabilityToBeatControl below is the
// one Bayesian-flavoured number, and it is labelled as an approximation
// because that is exactly what it is.
//
// CONTINUITY CORRECTION: off. Yates' correction makes the test conservative
// and is unnecessary at the sample sizes any of this is used at (hundreds
// upward). Documented rather than silently omitted.
// ============================================================================
import { normalCdf } from "./verdict";

// ---------------------------------------------------------------------------
// Inverse normal CDF. verdict.ts has Φ but not Φ⁻¹, and sample sizing needs
// the quantile (the z for a given confidence/power). Acklam's rational
// approximation, refined by one Halley step against the existing normalCdf —
// which both sharpens it to near machine precision and keeps this consistent
// with the Φ the rest of the tool uses.
// ---------------------------------------------------------------------------
const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
           1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
           6.680131188771972e1, -1.328068155288572e1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
           -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
           3.754408661907416];

/** Φ⁻¹(p) for 0 < p < 1. Throws outside that range rather than returning ±∞. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new RangeError(`normalQuantile expects 0 < p < 1, received ${p}`);
  }
  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
        ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q /
        (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
         ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  // One Halley refinement against the tool's own Φ.
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

export type MdeType = "relative" | "absolute";

export interface SampleSizeInput {
  /** Control conversion rate as a proportion, 0 < baselineRate < 1. */
  baselineRate: number;
  /** Minimum detectable effect. Relative (0.05 = a 5% lift) or absolute
   *  (0.05 = five percentage points), per mdeType. */
  mde: number;
  /** Default "relative": teams state lifts as percentages of the baseline. */
  mdeType?: MdeType;
  /** Type-I error. Default 0.05 → 95% confidence. */
  alpha?: number;
  /** 1 − type-II error. Default 0.8, the conventional floor. */
  power?: number;
  /** Two-sided by default: a variant can lose, and a one-sided test would
   *  hide that at the same alpha. */
  sides?: 1 | 2;
}

export interface SampleSizeResult {
  /** Visitors required PER ARM. Always a whole visitor, rounded up. */
  nPerArm: number;
  /** The absolute rate difference the test is powered to detect. */
  absoluteEffect: number;
  /** The variant rate implied by the MDE. */
  targetRate: number;
  alpha: number;
  power: number;
  sides: 1 | 2;
}

/**
 * Visitors per arm to detect `mde` at `alpha`/`power`, for a two-proportion
 * comparison. The standard pooled formulation Evan Miller's calculator uses:
 *
 *   n = ( z_{1−α/s}·√(2·p̄·(1−p̄)) + z_{power}·√(p₁(1−p₁)+p₂(1−p₂)) )² / δ²
 *
 * The two variance terms differ on purpose: the first is the null's pooled
 * variance (what alpha is spent against), the second the alternative's actual
 * variance (what power is computed under).
 */
export function sampleSizePerArm(input: SampleSizeInput): SampleSizeResult {
  const { baselineRate, mde } = input;
  const mdeType = input.mdeType ?? "relative";
  const alpha = input.alpha ?? 0.05;
  const power = input.power ?? 0.8;
  const sides = input.sides ?? 2;

  if (!(baselineRate > 0 && baselineRate < 1)) {
    throw new RangeError(`baselineRate must be between 0 and 1, received ${baselineRate}`);
  }
  if (!(mde > 0)) throw new RangeError(`mde must be positive, received ${mde}`);
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`alpha must be between 0 and 1, received ${alpha}`);
  if (!(power > 0 && power < 1)) throw new RangeError(`power must be between 0 and 1, received ${power}`);

  const p1 = baselineRate;
  const absoluteEffect = mdeType === "relative" ? p1 * mde : mde;
  const p2 = p1 + absoluteEffect;
  if (!(p2 > 0 && p2 < 1)) {
    throw new RangeError(
      `an MDE of ${mde} (${mdeType}) moves the ${p1} baseline to ${p2}, which is not a rate`,
    );
  }

  const zAlpha = normalQuantile(1 - alpha / sides);
  const zPower = normalQuantile(power);
  const pBar = (p1 + p2) / 2;

  const nullTerm = zAlpha * Math.sqrt(2 * pBar * (1 - pBar));
  const altTerm = zPower * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  const nPerArm = Math.ceil(((nullTerm + altTerm) ** 2) / (absoluteEffect ** 2));

  return { nPerArm, absoluteEffect, targetRate: p2, alpha, power, sides };
}

export interface DurationInput {
  nPerArm: number;
  /** Total arms including control. Two arms = control + one variant. */
  variants: number;
  /** Visitors per day eligible for the experiment. */
  dailyTraffic: number;
  /** Fraction of that traffic allocated to the test, 0 < allocation ≤ 1. */
  allocation?: number;
}

export interface DurationResult {
  days: number;
  /** Whole weeks, rounded up: partial weeks skew by weekday and should be
   *  planned as a full one. */
  weeks: number;
  totalVisitors: number;
  visitorsPerDay: number;
}

/** How long `nPerArm × variants` visitors take to arrive at the given rate. */
export function estimateDuration(input: DurationInput): DurationResult {
  const { nPerArm, variants, dailyTraffic } = input;
  const allocation = input.allocation ?? 1;

  if (!(nPerArm > 0)) throw new RangeError(`nPerArm must be positive, received ${nPerArm}`);
  if (!(variants >= 2)) throw new RangeError(`variants must be at least 2, received ${variants}`);
  if (!(dailyTraffic > 0)) throw new RangeError(`dailyTraffic must be positive, received ${dailyTraffic}`);
  if (!(allocation > 0 && allocation <= 1)) {
    throw new RangeError(`allocation must be between 0 and 1, received ${allocation}`);
  }

  const totalVisitors = nPerArm * variants;
  const visitorsPerDay = dailyTraffic * allocation;
  const days = Math.ceil(totalVisitors / visitorsPerDay);
  return { days, weeks: Math.ceil(days / 7), totalVisitors, visitorsPerDay };
}

// ---------------------------------------------------------------------------
// Chi-square upper tail, for the SRM test. df is small (arms − 1), so the
// regularised incomplete gamma via series + continued fraction is exact enough
// and stays dependency-free.
// ---------------------------------------------------------------------------
function lnGamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
             -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Regularised upper incomplete gamma Q(a,x) = 1 − P(a,x). */
function gammaQ(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 1;
  if (x < a + 1) {
    // Series for P(a,x), then complement.
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 500; n++) {
      ap++; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  // Lentz's continued fraction for Q(a,x) directly.
  const tiny = 1e-300;
  let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h * Math.exp(-x + a * Math.log(x) - lnGamma(a));
}

/** Upper-tail p for a chi-square statistic. */
export function chiSquarePValue(chiSquare: number, df: number): number {
  if (!(df > 0) || chiSquare < 0) return NaN;
  if (chiSquare === 0) return 1;
  return gammaQ(df / 2, chiSquare / 2);
}

export interface SrmResult {
  chiSquare: number;
  pValue: number;
  /** True when the split is off beyond chance — investigate the assignment
   *  before reading any result, because a broken split invalidates the test. */
  mismatch: boolean;
  df: number;
  observedSplit: number[];
  expectedCounts: number[];
}

/**
 * Sample Ratio Mismatch: a chi-square goodness-of-fit of the arm counts you
 * actually got against the split you asked for.
 *
 * The threshold is 0.001, not 0.05, and that is deliberate. SRM is checked on
 * every experiment, so at 0.05 one test in twenty would cry wolf; 0.001 is the
 * industry convention precisely because a flagged SRM should mean "stop and
 * look", not "this happens all the time".
 */
export function srmCheck(
  observedCounts: number[],
  expectedSplit: number[],
  alpha = 0.001,
): SrmResult {
  if (observedCounts.length !== expectedSplit.length) {
    throw new RangeError("observedCounts and expectedSplit must be the same length");
  }
  if (observedCounts.length < 2) {
    throw new RangeError("SRM needs at least two arms");
  }
  const total = observedCounts.reduce((a, b) => a + b, 0);
  const splitTotal = expectedSplit.reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw new RangeError("observedCounts must contain at least one visitor");
  if (!(splitTotal > 0)) throw new RangeError("expectedSplit must sum to a positive number");

  // The split is accepted as weights (50/50, 1/1, 0.5/0.5 all mean the same).
  const expectedCounts = expectedSplit.map((w) => (w / splitTotal) * total);
  let chiSquare = 0;
  for (let i = 0; i < observedCounts.length; i++) {
    const e = expectedCounts[i];
    if (e <= 0) continue;
    chiSquare += ((observedCounts[i] - e) ** 2) / e;
  }
  const df = observedCounts.length - 1;
  const pValue = chiSquarePValue(chiSquare, df);
  return {
    chiSquare,
    pValue,
    mismatch: pValue < alpha,
    df,
    observedSplit: observedCounts.map((c) => c / total),
    expectedCounts,
  };
}

export interface ArmRate {
  successes: number;
  trials: number;
}

/**
 * P(variant's true rate beats control's), by normal approximation to the two
 * Beta posteriors under a flat prior.
 *
 * Labelled Bayesian-lite on purpose: it is the normal approximation, not an
 * exact Beta integral or a simulation, and it is a SECONDARY read. The
 * decision number is the p-value from verdict.ts. This exists because "83%
 * likely to win" is easier to hold than a p-value, not because it is a
 * separate source of truth — the two can disagree at small samples, where the
 * normal approximation is weakest.
 */
export function probabilityToBeatControl(control: ArmRate, variant: ArmRate): number {
  if (!(control.trials > 0) || !(variant.trials > 0)) return 0.5;
  const p1 = control.successes / control.trials;
  const p2 = variant.successes / variant.trials;
  // Posterior variance under Beta(1,1): p(1−p)/(n+3) is the standard
  // normal-approximation form for a flat prior.
  const v1 = (p1 * (1 - p1)) / (control.trials + 3);
  const v2 = (p2 * (1 - p2)) / (variant.trials + 3);
  const se = Math.sqrt(v1 + v2);
  if (se === 0) return p2 === p1 ? 0.5 : p2 > p1 ? 1 : 0;
  return normalCdf((p2 - p1) / se);
}

export interface DiffInterval {
  /** Observed absolute difference, variant − control. */
  diff: number;
  low: number;
  high: number;
  alpha: number;
}

/**
 * Confidence interval for the absolute difference between two rates, using
 * the UNPOOLED standard error.
 *
 * Unpooled on purpose, and this is the one place it differs from
 * twoProportionZTest in verdict.ts: that test pools because it asks "could
 * these be the same rate?", where H0 says they share one rate. An interval
 * asks "how big is the difference?", which assumes they differ — so each arm
 * contributes its own variance. Using the pooled SE here would quietly
 * misstate the width.
 */
export function confidenceIntervalDiff(
  control: ArmRate,
  variant: ArmRate,
  alpha = 0.05,
): DiffInterval {
  if (!(control.trials > 0) || !(variant.trials > 0)) {
    throw new RangeError("both arms need at least one trial");
  }
  const p1 = control.successes / control.trials;
  const p2 = variant.successes / variant.trials;
  const diff = p2 - p1;
  const se = Math.sqrt(
    (p1 * (1 - p1)) / control.trials + (p2 * (1 - p2)) / variant.trials,
  );
  const z = normalQuantile(1 - alpha / 2);
  return { diff, low: diff - z * se, high: diff + z * se, alpha };
}
