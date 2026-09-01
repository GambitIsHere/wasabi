// ============================================================================
// Wasabi decision-helper — VERDICT (pure logic)
// ----------------------------------------------------------------------------
// Turns the per-variant payment P&L (from results.sql) into a business verdict:
// statistical significance vs control, a winner per metric, and an honest
// narrative + recommendation. This is the differentiator — VWO/PostHog tell you
// which variant got more clicks; this tells you which variant made more money
// per acquired customer, and whether the difference is real.
//
// REGISTRY-DRIVEN (this batch): buildVerdict() used to hardcode three metric
// names (auth_rate, rebill_rate, rev_per_acquired) and always assume "higher
// is better". It now iterates lib/metrics.ts's MetricDef[] registry — a
// metric is data, not code — and picks winners max/min per each metric's OWN
// direction. That is THE fix for a real, latent bug: Direction used to be a
// single-member union ("higher_is_better" only), so the moment a
// lower_is_better metric (churn rate, refund rate, CAC) was added, the winner
// logic would have declared the WORST-performing arm the winner. See
// isImprovement() in lib/metrics.ts for the "is this delta actually good"
// half of the fix — used below wherever a delta's sign needs judging, not
// just wherever a max/min is picked.
//
// PURE: no I/O, no DB, no deps. Inputs are rows + the metric registry; output
// is a structured Verdict. buildVerdict() takes `metrics: MetricDef[]` as an
// explicit parameter rather than reading the DB itself, so it stays testable
// with plain fixtures — the caller (an API route or server component) reads
// lib/metrics.ts's getMetrics() and passes the result in.
//
// The stats are implemented inline (two-proportion z-test + normal CDF via an
// Abramowitz-Stegun erf, plus a Welch's t-test for continuous metrics — see
// welchTTest) so we ship zero npm dependencies — Node builtins only.
// ============================================================================
// Sourced from metrics-core.ts (not metrics.ts) so this file stays genuinely
// dependency-free — metrics.ts imports lib/db.ts (Neon), which throws if ever
// evaluated in a browser bundle; metrics-core.ts is the client-safe pure half.
import type { Direction, MetricDef } from "./metrics-core";
import { isImprovement, metricValue, ratioComponents } from "./metrics-core";

export type { Direction } from "./metrics-core";

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

/** One arm of the experiment, straight from the results query (see results.sql). */
export interface VariantRow {
  /** Experiment variant key, e.g. "control" | "variant_19". */
  variant: string;
  /** The storefront theme slug this variant maps to, e.g. "tu_lov_uk_19". */
  themeSlug: string;
  /** Exactly one row should be the control (the baseline we test against). */
  isControl: boolean;
  /** Distinct applications acquired in the cohort — the £/acquired denominator. */
  appsAcquired: number;
  /** First-payment successes ("type"='paid'). */
  firstPaid: number;
  /** First-payment failures ("type"='failed'). Numerator of the auth-rate denom. */
  firstFailed: number;
  /** paid / (paid + failed), as a percentage. Directly from SQL (may be rounded). */
  authRate: number;
  /** Renewal successes ("type"='rebill'). */
  rebillOk: number;
  /** Renewal declines ("type"='rebill_failed'). Attempt-level — see caveat below. */
  rebillFail: number;
  /** rebill / (rebill + rebill_failed), as a percentage. */
  rebillRate: number;
  /** Cash collected: SUM(amountGBP) over paid + rebill. */
  revenueGbp: number;
  /** revenue_gbp / apps_acquired — the £ verdict per arm. */
  revPerAcquired: number;

  // --- Phase 1a: funnel · net revenue · break-even CAC · currency (all optional
  //     so older callers + the verdict stats keep working unchanged) ---
  /** Paid ad clicks attributed to this variant's theme (gAdsConversion). */
  adClicks?: number;
  /** Of those clicks, how many converted (gAdsConversion.converted). */
  adConversions?: number;
  /** Refunds: SUM(amountGBP) over full_refund + partial_refund. */
  refundsGbp?: number;
  /** Chargebacks: SUM(amountGBP) over open_/resolved_chargeback. */
  chargebacksGbp?: number;
  /** Net revenue = revenue − refunds − chargebacks (GBP). */
  netRevenueGbp?: number;
  /** Break-even CAC = net revenue ÷ apps acquired (GBP) — the most you can pay per acquisition. */
  breakEvenCacGbp?: number;
  /** The variant's transacted currency code (GBP/EUR/USD), for display. */
  currency?: string;
  /** Cash collected in the native currency: SUM(amount) over paid + rebill. */
  revenueNative?: number;
  /** revenueNative ÷ apps acquired. */
  revPerAcquiredNative?: number;
}

/** A two-proportion z-test of one variant's rate vs control's (ratio metrics only). */
export interface SignificanceTest {
  /** "<metric key> · <variant>", e.g. "auth_rate · variant_19". */
  metric: string;
  /** Control's rate as a proportion in [0,1] (e.g. 0.546). */
  controlRate: number;
  /** Variant's rate as a proportion in [0,1]. */
  variantRate: number;
  /** Successes / trials behind each rate, for transparency + sample-size checks. */
  controlSuccesses: number;
  controlTrials: number;
  variantSuccesses: number;
  variantTrials: number;
  /** Absolute lift in percentage points (variant − control), e.g. +22.9. Raw
   *  arithmetic — NOT sign-flipped for lower_is_better metrics; see `improvement`. */
  deltaPp: number;
  /** Relative lift, e.g. +1.18 = +118%. Same raw-arithmetic rule as deltaPp. */
  deltaRel: number;
  /** Pooled two-proportion z statistic. */
  z: number;
  /** Two-tailed p-value. */
  p: number;
  /** Confidence that the difference is real, as a percentage (100·(1−p)). */
  confidencePct: number;
  /** True when p < 0.05 (95% threshold) — statistical significance only, NOT
   *  a good/bad judgement (a metric can be significantly WORSE). See `improvement`. */
  significant: boolean;
  /** Scannable label, e.g. "99%+ confident", "not significant (p=0.21)". */
  label: string;
  /** This metric's direction, carried alongside the test so a consumer can
   *  judge good/bad without re-deriving it from the registry. */
  direction: Direction;
  /** True when this delta moves in the metric's FAVOURABLE direction — the
   *  direction-aware replacement for "deltaPp > 0" (a significant DROP on a
   *  lower_is_better metric is a significant improvement, not a regression).
   *  Independent of `significant`: combine as `significant && improvement`
   *  for "significantly better", `significant && !improvement` for
   *  "significantly worse". */
  improvement: boolean;
}

/** The winner on one business metric, with the delta vs control. `metric` is
 *  the registry's MetricDef.key — data-driven, not a hardcoded union, so any
 *  enabled metric (not just auth_rate/rebill_rate/rev_per_acquired) can win. */
export interface MetricWinner {
  metric: string;
  /** Variant key that leads on this metric. */
  winner: string;
  /** Control's value (in the metric's display unit — % for percent, £ for
   *  currency, etc; see lib/metrics.ts's metricValue). */
  controlValue: number;
  /** Winner's value, same unit as controlValue. */
  winnerValue: number;
  /** Absolute delta (winner − control), same unit as the values. Raw
   *  arithmetic — a WIN on a lower_is_better metric has delta < 0; read it
   *  via the metric's direction (or isImprovement from lib/metrics.ts), not
   *  by assuming positive = good. */
  delta: number;
  /** Relative delta vs control (e.g. +0.21 = +21%). Same raw-arithmetic rule. */
  deltaRel: number;
}

/** A metric whose significance couldn't be honestly tested, and why — never
 *  fabricated, always explained. Continuous metrics land here today because
 *  VariantRow only carries per-arm aggregates, not per-user variance (see
 *  CONTINUOUS_SIGNIFICANCE_UNAVAILABLE_REASON below). Sum metrics are NOT
 *  listed here — "no significance test" is definitional for a total, not a
 *  gap to apologise for. */
export interface UnavailableSignificance {
  metric: string;
  reason: string;
}

/** A ship / keep-running / inconclusive call. */
export type Recommendation = "ship" | "keep_running" | "inconclusive";

export interface Verdict {
  /** The control variant's key (everything is measured against this). */
  controlVariant: string;
  /** Per-variant, per-metric significance tests vs control (ratio metrics only;
   *  excludes control itself). */
  significance: SignificanceTest[];
  /** Metrics whose significance is honestly unavailable, and why. */
  unavailableSignificance: UnavailableSignificance[];
  /** Best variant on each enabled registry metric. */
  winners: MetricWinner[];
  /** The headline call. */
  recommendation: Recommendation;
  /** The variant we'd ship if recommendation === "ship" (else null). */
  recommendedVariant: string | null;
  /** Honest, nuanced prose — the read a careful analyst would write. */
  narrative: string;
}

// ---------------------------------------------------------------------------
// Stats primitives — inline, no libraries
// ---------------------------------------------------------------------------

/**
 * Gauss error function via Abramowitz & Stegun 7.1.26 (max abs error ~1.5e-7).
 * Good to ~6 decimals — far tighter than any A/B decision needs.
 */
function erf(x: number): number {
  // erf is odd: erf(-x) = -erf(x). Compute on |x| and reapply the sign.
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);

  const t = 1 / (1 + 0.3275911 * ax);
  // Horner's method on the 5-term polynomial.
  const poly =
    t * (0.254829592 +
    t * (-0.284496736 +
    t * (1.421413741 +
    t * (-1.453152027 +
    t * 1.061405429))));
  const y = 1 - poly * Math.exp(-ax * ax);
  return sign * y;
}

/** Standard-normal CDF Φ(x) = P(Z ≤ x), built from erf. */
function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Pooled two-proportion z-test. Returns the z statistic and a two-tailed
 * p-value for H0: the two underlying success rates are equal.
 *
 * Pooled because under H0 both samples share one true rate; the pooled
 * estimate gives the standard error of the difference. This is the textbook
 * test for comparing two binomial proportions (auth_rate, rebill_rate, and
 * any other "ratio" metric in the registry).
 */
function twoProportionZTest(
  s1: number, n1: number, // variant: successes, trials
  s2: number, n2: number, // control: successes, trials
): { z: number; p: number } {
  // Degenerate samples can't be tested.
  if (n1 <= 0 || n2 <= 0) return { z: 0, p: 1 };

  const p1 = s1 / n1;
  const p2 = s2 / n2;
  const pPool = (s1 + s2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));

  // No variance (e.g. pooled rate is 0 or 1) → no detectable difference.
  if (se === 0) return { z: 0, p: 1 };

  const z = (p1 - p2) / se;
  // Two-tailed: probability of a |Z| at least this large under H0.
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, p };
}

/**
 * Welch's t-test for two independent samples with unequal variances — the
 * textbook test for comparing two CONTINUOUS means (vs. the pooled
 * two-proportion z-test above, which is for two RATES). Real and unit-tested
 * (see verdict.test.ts), but NOT wired into buildVerdict below: VariantRow
 * carries only per-arm AGGREGATES for continuous metrics (a sum, a ratio of
 * sums) — no per-user variance or observation count, which a t-test needs to
 * compute a standard error. MetricDef (lib/metrics.ts) has no varianceField
 * either — out of this batch's schema. So every continuous metric's
 * significance is honestly "unavailable" today (see
 * CONTINUOUS_SIGNIFICANCE_UNAVAILABLE_REASON), not silently skipped. The day
 * VariantRow/MetricDef grow real per-user variance + n, wire it into
 * buildVerdict's continuous-metric branch instead of the constant reason.
 */
export function welchTTest(
  mean1: number, variance1: number, n1: number,
  mean2: number, variance2: number, n2: number,
): { t: number; p: number } | null {
  // A variance estimate needs at least 2 observations per side.
  if (n1 < 2 || n2 < 2) return null;

  const se2 = variance1 / n1 + variance2 / n2;
  if (se2 <= 0) return { t: 0, p: 1 };
  const se = Math.sqrt(se2);
  const t = (mean1 - mean2) / se;
  // Two-tailed p-value via the normal approximation to the t-distribution.
  // Exact would need the Welch-Satterthwaite degrees of freedom plus an
  // incomplete-beta/t-CDF; the normal approximation is standard practice once
  // df is more than ~30 and keeps this dependency-free like the rest of the
  // file. A documented simplification, not a silent one.
  const p = 2 * (1 - normalCdf(Math.abs(t)));
  return { t, p };
}

/** Turn a p-value into a scannable confidence label. */
function confidenceLabel(p: number): string {
  if (p < 0.001) return "99.9%+ confident";
  if (p < 0.01) return "99% confident";
  if (p < 0.05) return "95% confident";
  if (p < 0.1) return `weak (90%, p=${p.toFixed(3)})`;
  return `not significant (p=${p.toFixed(3)})`;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Build one significance test of a variant's ratio-metric proportion vs
 *  control's. `def` supplies both the metric key (for the "<key> · <variant>"
 *  label every consumer keys off) and the direction (for `improvement`). */
function buildTest(
  def: MetricDef,
  variantKey: string,
  variantSucc: number, variantTrials: number,
  controlSucc: number, controlTrials: number,
): SignificanceTest {
  const variantRate = variantTrials > 0 ? variantSucc / variantTrials : 0;
  const controlRate = controlTrials > 0 ? controlSucc / controlTrials : 0;
  const { z, p } = twoProportionZTest(variantSucc, variantTrials, controlSucc, controlTrials);
  const deltaPp = (variantRate - controlRate) * 100;

  return {
    metric: `${def.key} · ${variantKey}`,
    controlRate,
    variantRate,
    controlSuccesses: controlSucc,
    controlTrials,
    variantSuccesses: variantSucc,
    variantTrials,
    deltaPp,
    deltaRel: controlRate > 0 ? (variantRate - controlRate) / controlRate : 0,
    z,
    p,
    confidencePct: (1 - p) * 100,
    significant: p < 0.05,
    label: confidenceLabel(p),
    direction: def.direction,
    improvement: isImprovement(def.direction, deltaPp),
  };
}

/**
 * Pick the leading row on one metric, direction-aware — THE Direction bug
 * fix: this used to always pick the row with the highest value (see the file
 * header). Now picks max for higher_is_better, min for lower_is_better.
 * Returns null when the metric can't be resolved for the CONTROL row (nothing
 * to compare against) — the caller skips it from the verdict entirely rather
 * than fabricating a winner or a zero.
 */
function buildWinner(def: MetricDef, control: VariantRow, rows: VariantRow[]): MetricWinner | null {
  const controlValue = metricValue(def, control);
  if (controlValue === null) return null;

  let winnerRow = control;
  let winnerValue = controlValue;
  for (const r of rows) {
    const v = metricValue(def, r);
    if (v === null) continue; // unresolved for this arm — can't win, can't lose
    const better = def.direction === "higher_is_better" ? v > winnerValue : v < winnerValue;
    if (better) {
      winnerRow = r;
      winnerValue = v;
    }
  }

  const delta = winnerValue - controlValue;
  return {
    metric: def.key,
    winner: winnerRow.variant,
    controlValue,
    winnerValue,
    delta,
    deltaRel: controlValue !== 0 ? delta / controlValue : 0,
  };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** A "thin" arm: too few rebill attempts to trust the rebill signal. */
const MIN_REBILL_TRIALS = 200;
/** A "thin" arm overall: too few acquisitions to trust £/acquired. */
const MIN_APPS_ACQUIRED = 1000;

/** Why continuous metrics never get a significance test today — see
 *  welchTTest's doc comment for the full reasoning. */
const CONTINUOUS_SIGNIFICANCE_UNAVAILABLE_REASON =
  "VariantRow carries only per-arm aggregates for continuous metrics — no per-user variance to test.";

/**
 * Produce the full business verdict from per-variant rows and the enabled
 * metric registry. `metrics` is an explicit parameter (not read from the DB
 * here) so this stays pure and testable — the caller reads
 * lib/metrics.ts's getMetrics() and passes the result in.
 *
 * Significance is tested on every "ratio" metric (auth_rate, rebill_rate, and
 * any future one) for every non-control variant vs control. "continuous"
 * metrics get an honest unavailable note instead of a fabricated test (see
 * CONTINUOUS_SIGNIFICANCE_UNAVAILABLE_REASON); "sum" metrics get neither — a
 * total has no per-unit variance to test.
 *
 * The recommendation is deliberately conservative and — unlike winners/
 * significance — stays keyed to THREE SPECIFIC metrics by name
 * (rev_per_acquired as the money metric, auth_rate/rebill_rate as drivers):
 * that is a product decision about what "ship" means, not the kind of
 * per-metric hardcoding this batch removes. We only say "ship" when an arm
 * both wins on the money metric AND has a statistically significant,
 * IMPROVING edge on a driver, with adequate sample — never on thin data or a
 * £ lead alone. If the money metric is ever disabled/deleted from the
 * registry, this degrades to "inconclusive" rather than throwing.
 */
export function buildVerdict(rows: VariantRow[], metrics: MetricDef[]): Verdict {
  const control = rows.find((r) => r.isControl);
  if (!control) throw new Error("buildVerdict: no control row (exactly one row must have isControl=true)");

  const variants = rows.filter((r) => !r.isControl);
  const enabledMetrics = metrics.filter((m) => m.enabled);

  // --- significance: ratio metrics vs control; continuous metrics noted as
  // unavailable; sum metrics skipped entirely (no test to run or apologise for) ---
  const significance: SignificanceTest[] = [];
  const unavailableSignificance: UnavailableSignificance[] = [];
  for (const def of enabledMetrics) {
    if (def.kind === "ratio") {
      for (const v of variants) {
        const vComp = ratioComponents(def, v);
        const cComp = ratioComponents(def, control);
        if (!vComp || !cComp) continue; // a referenced field is missing on this row — skip, never crash
        significance.push(
          buildTest(def, v.variant, vComp.numerator, vComp.denominator, cComp.numerator, cComp.denominator),
        );
      }
    } else if (def.kind === "continuous") {
      unavailableSignificance.push({
        metric: def.key,
        reason: CONTINUOUS_SIGNIFICANCE_UNAVAILABLE_REASON,
      });
    }
  }

  // --- winners: one per enabled metric, iterating the registry instead of a
  // hardcoded metric list. A metric unresolvable for control is skipped
  // entirely (buildWinner returns null) rather than faked. ---
  const winners: MetricWinner[] = [];
  for (const def of enabledMetrics) {
    const w = buildWinner(def, control, rows);
    if (w) winners.push(w);
  }

  // --- recommendation ---
  const revWinner = winners.find((w) => w.metric === "rev_per_acquired");
  let recommendation: Recommendation;
  let recommendedVariant: string | null;

  if (!revWinner) {
    // The money metric isn't in the (enabled) registry — nothing to
    // recommend on. Degrade to the same conservative call as "no challenger
    // cleared the bar" rather than throwing.
    recommendation = "inconclusive";
    recommendedVariant = null;
  } else {
    const revWinnerRow = rows.find((r) => r.variant === revWinner.winner)!;
    const revWinnerBeatsControl = revWinner.winner !== control.variant;

    // Is the money winner's edge backed by a SIGNIFICANT, adequately-sampled,
    // IMPROVING driver (auth or rebill, or any future ratio metric) in its favour?
    const winnerSigTests = significance.filter((s) => s.metric.endsWith(`· ${revWinner.winner}`));
    const hasSignificantPositiveDriver = winnerSigTests.some(
      (s) =>
        s.significant &&
        s.improvement &&
        // require real sample behind whichever rate carried it
        (s.metric.startsWith("rebill_rate") ? s.variantTrials >= MIN_REBILL_TRIALS : s.variantTrials >= 200),
    );
    const winnerHasSample = revWinnerRow.appsAcquired >= MIN_APPS_ACQUIRED;

    if (revWinnerBeatsControl && hasSignificantPositiveDriver && winnerHasSample) {
      recommendation = "ship";
      recommendedVariant = revWinner.winner;
    } else if (revWinnerBeatsControl && winnerHasSample) {
      // Leads on money but the driver isn't (yet) significant — let it run.
      recommendation = "keep_running";
      recommendedVariant = null;
    } else {
      recommendation = "inconclusive";
      recommendedVariant = null;
    }
  }

  const narrative = buildNarrative(
    control,
    rows,
    significance,
    winners,
    unavailableSignificance,
    metrics,
    recommendation,
    recommendedVariant,
  );

  return {
    controlVariant: control.variant,
    significance,
    unavailableSignificance,
    winners,
    recommendation,
    recommendedVariant,
    narrative,
  };
}

// ---------------------------------------------------------------------------
// Narrative — the honest analyst read
// ---------------------------------------------------------------------------

function pp(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}pp`;
}
function rel(n: number): string {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`;
}
function gbp(n: number): string {
  return `£${n.toFixed(2)}`;
}

/**
 * Writes the read a careful analyst would write: what won, whether it's real,
 * the cheaper-plan tradeoff (rebill collection up, £/customer capped), the LTV
 * caveat, explicit small-sample flags, and — new this batch — an honest note
 * on any metric whose significance couldn't be tested. Mirrors the honest,
 * nuanced house style — never over-claims a winner on thin data, and never
 * claims a test that wasn't run.
 */
function buildNarrative(
  control: VariantRow,
  rows: VariantRow[],
  significance: SignificanceTest[],
  winners: MetricWinner[],
  unavailableSignificance: UnavailableSignificance[],
  metrics: MetricDef[],
  recommendation: Recommendation,
  recommendedVariant: string | null,
): string {
  const lines: string[] = [];
  const metricByKey = new Map(metrics.map((m) => [m.key, m]));
  const revWinner = winners.find((w) => w.metric === "rev_per_acquired");
  const authWinner = winners.find((w) => w.metric === "auth_rate");
  const rebillDef = metricByKey.get("rebill_rate");

  // --- headline on the money metric ---
  if (revWinner) {
    if (revWinner.winner === control.variant) {
      lines.push(
        `Control still leads on the money metric (${gbp(control.revPerAcquired)}/acquired). ` +
        `No challenger beats the baseline on £ per acquired customer.`,
      );
    } else {
      lines.push(
        `${revWinner.winner} leads on the money metric at ${gbp(revWinner.winnerValue)}/acquired ` +
        `vs control's ${gbp(revWinner.controlValue)} (${rel(revWinner.deltaRel)}).`,
      );
    }
  }

  // --- the cheaper-plan tradeoff, read off the data ---
  // Find the arm with the biggest IMPROVING rebill move vs control — typically
  // the cheapest plan: easier to collect on renewal, but it caps £/customer.
  // "Biggest improving move" is direction-aware: for a (today hypothetical)
  // lower_is_better rebill-adjacent metric, that would mean the largest DROP,
  // not the largest raw deltaPp.
  if (rebillDef) {
    const rebillTests = significance.filter((s) => s.metric.startsWith("rebill_rate"));
    const bestRebill = rebillTests.reduce<SignificanceTest | null>((best, t) => {
      if (best === null) return t;
      const tBetter =
        rebillDef.direction === "higher_is_better" ? t.deltaPp > best.deltaPp : t.deltaPp < best.deltaPp;
      return tBetter ? t : best;
    }, null);
    if (bestRebill && isImprovement(rebillDef.direction, bestRebill.deltaPp)) {
      const arm = bestRebill.metric.split("· ")[1]!;
      const armRow = rows.find((r) => r.variant === arm)!;
      const collectsBetterButEarnsLess =
        armRow.revPerAcquired < control.revPerAcquired && bestRebill.significant;
      lines.push(
        `${arm} lifts renewal collection hard — rebill_rate ${(bestRebill.variantRate * 100).toFixed(1)}% ` +
        `vs control ${(bestRebill.controlRate * 100).toFixed(1)}% (${pp(bestRebill.deltaPp)}, ${rel(bestRebill.deltaRel)}; ${bestRebill.label})` +
        (collectsBetterButEarnsLess
          ? `, the classic cheaper-plan pattern: collection goes up because a smaller charge clears more cards, but the lower price caps £/customer (${gbp(armRow.revPerAcquired)}/acquired, below control).`
          : `.`),
      );
    }
  }

  // --- auth_rate: usually small + noisy, say so when it is ---
  const authTests = significance.filter((s) => s.metric.startsWith("auth_rate"));
  const anyAuthSignificant = authTests.some((t) => t.significant);
  if (authTests.length > 0 && authWinner) {
    if (!anyAuthSignificant) {
      lines.push(
        `First-payment auth_rate moves are small and within noise — none of the variants is ` +
        `statistically distinguishable from control on auth (so price isn't materially helping or hurting card approval).`,
      );
    } else {
      const sig = authTests.filter((t) => t.significant).map((t) => t.metric.split("· ")[1]!).join(", ");
      lines.push(
        `auth_rate shows a real difference for ${sig} (best auth: ${authWinner.winner} at ` +
        `${authWinner.winnerValue.toFixed(1)}%, ${pp(authWinner.delta)} vs control).`,
      );
    }
  }

  // --- LTV horizon: the call hinges on it (only makes sense when there IS a
  // money metric to re-read) ---
  if (revWinner) {
    lines.push(
      `The call hinges on the LTV horizon. £/acquired here is collected-to-date, not lifetime: a cheaper ` +
      `plan that renews more reliably can overtake a pricier one over enough billing cycles, so a £ lead ` +
      `today is not a settled LTV verdict. Re-read once each arm has several rebill cycles behind it.`,
    );
  }

  // --- explicit sample-size flags ---
  const thin = rows.filter((r) => r.appsAcquired < MIN_APPS_ACQUIRED || (r.rebillOk + r.rebillFail) < MIN_REBILL_TRIALS);
  if (thin.length > 0) {
    const flags = thin.map(
      (r) => `${r.variant} (${r.appsAcquired.toLocaleString()} apps, ${(r.rebillOk + r.rebillFail).toLocaleString()} rebill attempts)`,
    );
    lines.push(`Sample caveat — thin arms, treat their deltas as directional: ${flags.join("; ")}.`);
  }

  // --- methodological caveat on rebill_failed ---
  if (rebillDef) {
    lines.push(
      `Caveat: rebill_failed is attempt-level (PSP retries inflate it), so rebill_rate is a directional ` +
      `collection signal, not an exact per-subscription rate — confirm a winner against the deduped (by subscriptionId) rate before shipping.`,
    );
  }

  // --- honest caveat for metrics with no significance test available ---
  if (unavailableSignificance.length > 0) {
    const list = unavailableSignificance.map((u) => u.metric).join(", ");
    lines.push(
      `Significance is not available for ${list}: these are continuous metrics and VariantRow only carries ` +
      `per-arm totals, not the per-user variance a t-test needs. Their winners and deltas above are real — ` +
      `read them as directional, not statistically tested.`,
    );
  }

  // --- the recommendation ---
  if (recommendation === "ship" && recommendedVariant) {
    lines.push(
      `RECOMMENDATION — SHIP ${recommendedVariant}: it wins on £/acquired with a statistically significant, ` +
      `adequately-sampled driver behind it. Verify the rebill lift on the deduped rate, then roll out.`,
    );
  } else if (recommendation === "keep_running") {
    lines.push(
      `RECOMMENDATION — KEEP RUNNING: a challenger leads on £/acquired but its driver isn't yet significant ` +
      `at the 95% bar. Let it accrue more rebill cycles before calling it; do not ship on the £ lead alone.`,
    );
  } else {
    lines.push(
      `RECOMMENDATION — INCONCLUSIVE: no challenger clears the bar (beat control on £/acquired with a significant, ` +
      `well-sampled driver). Keep control live and keep measuring; the honest read is "not yet decided".`,
    );
  }

  return lines.join("\n\n");
}
