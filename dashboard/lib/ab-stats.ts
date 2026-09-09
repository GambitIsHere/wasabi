// ============================================================================
// Wasabi A/B calculator — the PLAN-side statistics engine.
// ----------------------------------------------------------------------------
// verdict.ts answers "did the test win?" (two-proportion z-test, CI, winner,
// narrative). This file answers everything you need BEFORE a test runs and
// while it runs: how big a sample each arm needs, how long that takes at a
// given traffic level, a standalone two-proportion analysis, a sample-ratio
// mismatch (SRM) health check, and a probability-to-beat-control read.
//
// ONE numeric core. Rather than ship a second erf / normal-CDF / z-test, this
// file imports the exact primitives verdict.ts already uses (erf, normalCdf,
// twoProportionZTest — exported from there this batch). analyzeTwoProportion
// is a thin wrapper over twoProportionZTest plus uplift + a Wald CI; it does
// NOT re-derive the z math. The only numeric machinery added here is what
// verdict.ts genuinely lacks: an inverse-normal quantile (needed for sample
// size / CI critical values) and a chi-square survival function (needed for
// SRM). Both are standard, dependency-free, and cross-checked in the tests.
//
// PURE: zero runtime dependencies, no DOM, no I/O. Every function is a plain
// input→output computation so the marketing page can vendor this file verbatim
// and the create-experiment helper can call it in the browser.
//
// METHOD NOTES (documented simplifications, not silent ones):
//  • Sample size uses the pooled-variance normal approximation for two
//    proportions (Fleiss / the formula behind Evan Miller's calculator).
//    NO continuity correction — matching verdict.ts's z-test, and standard for
//    A/B sizing. Results land within ~1-3% of Evan Miller / statsmodels.
//  • The z-test pools variance under H0 (via twoProportionZTest); the CI uses
//    the UNPOOLED Wald standard error. That split is textbook: the test
//    assumes equal rates, the interval does not.
//  • probabilityToBeatControl is a normal approximation to P(variant > control),
//    not a Beta-Binomial Monte Carlo — a fast secondary read, labelled as such.
// ============================================================================
import { erf, normalCdf, twoProportionZTest } from "./verdict";

// Re-export the shared primitives so a vendoring consumer can pull the whole
// numeric surface from one module if it prefers.
export { erf, normalCdf, twoProportionZTest };

// ---------------------------------------------------------------------------
// Defaults — applied wherever a caller omits an optional field. Kept as named
// constants so the create-experiment UI and the marketing page agree on them.
// ---------------------------------------------------------------------------
export const DEFAULT_ALPHA = 0.05;
export const DEFAULT_POWER = 0.8;
export const DEFAULT_SIDES: 1 | 2 = 2;
export const DEFAULT_MDE_TYPE: "relative" | "absolute" = "relative";
/** SRM alarm threshold. An imbalance this improbable under the intended split
 *  is a plumbing bug (mis-bucketed traffic, a broken redirect), not chance.
 *  0.001 is the conventional SRM bar — low enough that a healthy test almost
 *  never trips it, high enough to catch a real mismatch fast. */
export const SRM_ALPHA = 0.001;

// ---------------------------------------------------------------------------
// Inverse normal (probit) — the one primitive verdict.ts doesn't have.
// ---------------------------------------------------------------------------

/**
 * Inverse standard-normal CDF: returns z such that Φ(z) = p, for p in (0,1).
 * Peter Acklam's rational approximation (abs error ~1.15e-9), then ONE Halley
 * refinement step using the shared normalCdf/erf so the result is good to
 * near machine precision — the refinement is why this reuses the core instead
 * of standing alone. p ≤ 0 → -∞, p ≥ 1 → +∞ (honest limits, not clamped).
 */
export function normalQuantile(p: number): number {
  if (Number.isNaN(p)) return NaN;
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;

  // Acklam coefficients.
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let x: number;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  // One Halley step against the shared normalCdf to sharpen the approximation.
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  x = x - u / (1 + (x * u) / 2);
  return x;
}

// ---------------------------------------------------------------------------
// Chi-square survival — the other primitive SRM needs. Regularized incomplete
// gamma via Numerical Recipes (series + continued fraction), Lanczos lnΓ.
// ---------------------------------------------------------------------------

/** Log-gamma via the Lanczos approximation (g=7). Accurate to ~1e-13. */
function lnGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula for the left half-plane.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Regularized lower incomplete gamma P(a, x) = γ(a,x)/Γ(a), for a>0, x≥0.
 * Series expansion for x < a+1, continued fraction (via its complement) above.
 */
function regularizedGammaP(a: number, x: number): number {
  if (x <= 0 || a <= 0) return 0;
  const gln = lnGamma(a);

  if (x < a + 1) {
    // Series representation.
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 300; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }

  // Continued fraction for Q(a,x) = 1 - P(a,x) (Lentz's algorithm).
  const FPMIN = 1e-300;
  let bTerm = x + 1 - a;
  let cTerm = 1 / FPMIN;
  let dTerm = 1 / bTerm;
  let h = dTerm;
  for (let i = 1; i <= 300; i++) {
    const an = -i * (i - a);
    bTerm += 2;
    dTerm = an * dTerm + bTerm;
    if (Math.abs(dTerm) < FPMIN) dTerm = FPMIN;
    cTerm = bTerm + an / cTerm;
    if (Math.abs(cTerm) < FPMIN) cTerm = FPMIN;
    dTerm = 1 / dTerm;
    const del = dTerm * cTerm;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  const q = Math.exp(-x + a * Math.log(x) - gln) * h;
  return 1 - q;
}

/** Upper-tail chi-square: P(X² ≥ x) for `df` degrees of freedom. */
function chiSquareSurvival(x: number, df: number): number {
  if (df <= 0) return 1;
  if (x <= 0) return 1;
  return 1 - regularizedGammaP(df / 2, x / 2);
}

// ---------------------------------------------------------------------------
// 1) Sample size per arm
// ---------------------------------------------------------------------------

export interface SampleSizeOpts {
  /** Control conversion rate as a proportion in (0,1), e.g. 0.12 for 12%. */
  baselineRate: number;
  /** Minimum detectable effect. Read per `mdeType`: relative 0.1 = "+10% of
   *  the baseline"; absolute 0.02 = "+2 percentage points". */
  mde: number;
  /** How `mde` is interpreted. Default "relative". */
  mdeType?: "relative" | "absolute";
  /** Significance level (Type-I error). Default 0.05. */
  alpha?: number;
  /** Statistical power (1 − Type-II error). Default 0.8. */
  power?: number;
  /** 1 = one-sided test, 2 = two-sided. Default 2. */
  sides?: 1 | 2;
}

/**
 * Required sample size PER ARM to detect `mde` at the given confidence + power,
 * as an integer (rounded up). Pooled-variance normal approximation, no
 * continuity correction (see the file header).
 *
 * Returns Number.POSITIVE_INFINITY for a request that can't be sized:
 * MDE of 0 (needs infinite data), a target rate that lands outside (0,1)
 * (e.g. baseline 90% with +20% relative → 108%, impossible), or an out-of-range
 * alpha/power/baseline. Callers render that as "not sizeable" rather than a
 * bogus finite number.
 */
export function sampleSizePerArm(opts: SampleSizeOpts): number {
  const {
    baselineRate: p1,
    mde,
    mdeType = DEFAULT_MDE_TYPE,
    alpha = DEFAULT_ALPHA,
    power = DEFAULT_POWER,
    sides = DEFAULT_SIDES,
  } = opts;

  // Guard the inputs — every degenerate case is "can't size", i.e. Infinity.
  if (!(p1 > 0 && p1 < 1)) return Number.POSITIVE_INFINITY;
  if (!(alpha > 0 && alpha < 1)) return Number.POSITIVE_INFINITY;
  if (!(power > 0 && power < 1)) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(mde) || mde === 0) return Number.POSITIVE_INFINITY;

  const p2 = mdeType === "relative" ? p1 * (1 + mde) : p1 + mde;
  if (!(p2 > 0 && p2 < 1)) return Number.POSITIVE_INFINITY;

  const delta = p2 - p1;
  if (delta === 0) return Number.POSITIVE_INFINITY;

  const zAlpha = normalQuantile(1 - alpha / sides);
  const zBeta = normalQuantile(power);

  const pBar = (p1 + p2) / 2;
  const sdNull = Math.sqrt(2 * pBar * (1 - pBar));
  const sdAlt = Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));

  const n = ((zAlpha * sdNull + zBeta * sdAlt) / delta) ** 2;
  if (!Number.isFinite(n)) return Number.POSITIVE_INFINITY;
  return Math.ceil(n);
}

// ---------------------------------------------------------------------------
// 2) Duration estimate
// ---------------------------------------------------------------------------

export interface DurationOpts {
  /** Required sample per arm (from sampleSizePerArm). */
  nPerArm: number;
  /** Number of arms, including control (2 for a plain A/B). */
  variants: number;
  /** Visitors per day the whole property sees. */
  dailyTraffic: number;
  /** Fraction of that traffic routed INTO the experiment, 0..1 (1 = all of it). */
  allocation: number;
}

export interface DurationResult {
  /** Whole days to reach the total sample (rounded up). Infinity if traffic ≤ 0. */
  days: number;
  /** Same span in weeks, to one decimal. Infinity if traffic ≤ 0. */
  weeks: number;
}

/**
 * How long to accrue `nPerArm × variants` total visitors at the given daily
 * traffic and allocation. `days` is rounded UP (a partial day doesn't finish a
 * test); `weeks` is days/7 to one decimal for a quick human read. Zero/negative
 * effective traffic → Infinity (the test never completes at that rate).
 */
export function estimateDuration(opts: DurationOpts): DurationResult {
  const { nPerArm, variants, dailyTraffic, allocation } = opts;
  const totalNeeded = nPerArm * variants;
  const usableDaily = dailyTraffic * allocation;

  if (!Number.isFinite(totalNeeded) || !(usableDaily > 0)) {
    return { days: Number.POSITIVE_INFINITY, weeks: Number.POSITIVE_INFINITY };
  }

  const days = Math.ceil(totalNeeded / usableDaily);
  const weeks = Math.round((days / 7) * 10) / 10;
  return { days, weeks };
}

// ---------------------------------------------------------------------------
// 3) Two-proportion analysis (thin wrapper over verdict.ts's z-test)
// ---------------------------------------------------------------------------

export interface ArmCounts {
  /** Visitors (trials) in this arm. */
  visitors: number;
  /** Conversions (successes) in this arm. */
  conversions: number;
}

export interface AnalyzeOpts {
  control: ArmCounts;
  variant: ArmCounts;
  /** Significance level. Default 0.05. */
  alpha?: number;
  /** 1 = one-sided (H1: variant > control), 2 = two-sided. Default 2. */
  sides?: 1 | 2;
}

export interface AnalyzeResult {
  /** Control conversion rate, proportion in [0,1]. */
  rateC: number;
  /** Variant conversion rate, proportion in [0,1]. */
  rateV: number;
  /** Absolute uplift (rateV − rateC), in proportion points. */
  absUplift: number;
  /** Relative uplift (absUplift / rateC). Infinity if control converted zero. */
  relUplift: number;
  /** Pooled two-proportion z statistic (sign: + when variant leads). */
  zScore: number;
  /** p-value — two-tailed for sides=2; upper-tail (variant > control) for sides=1. */
  pValue: number;
  /** True when pValue < alpha. */
  significant: boolean;
  /** Wald CI (lower) for the absolute uplift, at the test's critical z. */
  ciLow: number;
  /** Wald CI (upper) for the absolute uplift. */
  ciHigh: number;
}

/**
 * Analyse an observed two-arm result. Delegates the z + p math to verdict.ts's
 * twoProportionZTest (pooled, two-tailed), then adds uplift and a Wald CI on
 * the difference. For a one-sided request the p-value is the upper tail
 * P(Z > z) — a variant that came out worse yields p > 0.5 (not significant),
 * by design. The CI uses the UNPOOLED (Wald) standard error and the critical
 * value z = Φ⁻¹(1 − alpha/sides).
 */
export function analyzeTwoProportion(opts: AnalyzeOpts): AnalyzeResult {
  const { control, variant, alpha = DEFAULT_ALPHA, sides = DEFAULT_SIDES } = opts;
  const nC = control.visitors;
  const nV = variant.visitors;
  const rateC = nC > 0 ? control.conversions / nC : 0;
  const rateV = nV > 0 ? variant.conversions / nV : 0;
  const absUplift = rateV - rateC;
  const relUplift =
    rateC > 0 ? absUplift / rateC : absUplift === 0 ? 0 : Number.POSITIVE_INFINITY;

  // The z math is verdict.ts's — variant is (s1,n1), control is (s2,n2), so a
  // positive z means the variant leads (matches SignificanceTest's convention).
  const { z, p: pTwo } = twoProportionZTest(
    variant.conversions,
    nV,
    control.conversions,
    nC,
  );
  const pValue = sides === 1 ? 1 - normalCdf(z) : pTwo;
  const significant = pValue < alpha;

  // Wald CI on the difference (unpooled SE), at the test's critical z.
  const seDiff = Math.sqrt(
    (nC > 0 ? (rateC * (1 - rateC)) / nC : 0) +
      (nV > 0 ? (rateV * (1 - rateV)) / nV : 0),
  );
  const zCrit = normalQuantile(1 - alpha / sides);
  const half = zCrit * seDiff;
  const ciLow = absUplift - half;
  const ciHigh = absUplift + half;

  return { rateC, rateV, absUplift, relUplift, zScore: z, pValue, significant, ciLow, ciHigh };
}

// ---------------------------------------------------------------------------
// 4) Sample-ratio mismatch (SRM) — a plumbing health check
// ---------------------------------------------------------------------------

export interface SrmResult {
  /** Pearson chi-square statistic across the arms. */
  chiSquare: number;
  /** P(χ² ≥ chiSquare) at (arms − 1) degrees of freedom. */
  pValue: number;
  /** True when pValue < SRM_ALPHA — the split is off enough to suspect a bug. */
  mismatch: boolean;
}

/**
 * Sample-ratio mismatch check. `observed` is the actual per-arm visitor counts;
 * `expectedSplit` is the intended ratio (any positive weights — [50,50],
 * [1,1], [0.5,0.5] all mean 50/50; they're normalised to the observed total).
 * A low p-value means the traffic didn't split the way it was configured —
 * almost always a bucketing/redirect bug, not chance — so the whole result is
 * suspect until it's fixed. Degenerate inputs (length mismatch, no traffic, a
 * zero expected weight) return a non-mismatch with p=1 rather than throwing.
 */
export function srmCheck(observed: number[], expectedSplit: number[]): SrmResult {
  const k = observed.length;
  if (k < 2 || expectedSplit.length !== k) {
    return { chiSquare: 0, pValue: 1, mismatch: false };
  }
  const total = observed.reduce((s, n) => s + n, 0);
  const weightSum = expectedSplit.reduce((s, w) => s + w, 0);
  if (!(total > 0) || !(weightSum > 0)) {
    return { chiSquare: 0, pValue: 1, mismatch: false };
  }

  let chiSquare = 0;
  for (let i = 0; i < k; i++) {
    const expected = total * (expectedSplit[i] / weightSum);
    if (!(expected > 0)) {
      // An arm expected to get zero traffic can't be chi-square tested.
      return { chiSquare: 0, pValue: 1, mismatch: false };
    }
    const diff = observed[i] - expected;
    chiSquare += (diff * diff) / expected;
  }

  const pValue = chiSquareSurvival(chiSquare, k - 1);
  return { chiSquare, pValue, mismatch: pValue < SRM_ALPHA };
}

// ---------------------------------------------------------------------------
// 5) Probability to beat control (secondary, normal approximation)
// ---------------------------------------------------------------------------

/**
 * P(variant's true rate > control's true rate), via the normal approximation:
 * the difference of two independent rate estimates is treated as normal, so
 * the probability is Φ((rateV − rateC) / SE_diff). This is a fast secondary
 * read — NOT a Beta-Binomial Monte Carlo — and is intentionally direction-only
 * (it says how likely the variant is ahead, not by how much). Returns 0..1;
 * an empty arm or zero variance returns 0.5 (no information) unless the point
 * estimates already separate the arms.
 */
export function probabilityToBeatControl(control: ArmCounts, variant: ArmCounts): number {
  const nC = control.visitors;
  const nV = variant.visitors;
  if (!(nC > 0) || !(nV > 0)) return 0.5;

  const rateC = control.conversions / nC;
  const rateV = variant.conversions / nV;
  const seDiff = Math.sqrt(
    (rateC * (1 - rateC)) / nC + (rateV * (1 - rateV)) / nV,
  );

  if (!(seDiff > 0)) {
    // No variance (both arms all-or-nothing) — fall back to the point estimates.
    if (rateV > rateC) return 1;
    if (rateV < rateC) return 0;
    return 0.5;
  }
  // Clamp: the A&S normalCdf can round a hair past 1 at extreme separation.
  return Math.min(1, Math.max(0, normalCdf((rateV - rateC) / seDiff)));
}
