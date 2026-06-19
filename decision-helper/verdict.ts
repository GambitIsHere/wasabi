// ============================================================================
// Wasabi decision-helper — VERDICT (pure logic)
// ----------------------------------------------------------------------------
// Turns the per-variant payment P&L (from results.sql) into a business verdict:
// statistical significance vs control, a winner per metric, and an honest
// narrative + recommendation. This is the differentiator — VWO/PostHog tell you
// which variant got more clicks; this tells you which variant made more money
// per acquired customer, and whether the difference is real.
//
// PURE: no I/O, no DB, no deps. Input is rows; output is a structured Verdict.
// The stats are implemented inline (two-proportion z-test + normal CDF via an
// Abramowitz-Stegun erf) so we ship zero npm dependencies — Node builtins only.
// ============================================================================

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
}

/** Which way is "good" for a metric — used to colour winners and deltas. */
export type Direction = "higher_is_better";

/** A two-proportion z-test of one variant's rate vs control's. */
export interface SignificanceTest {
  /** Human label for the metric, e.g. "auth_rate" or "rebill_rate". */
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
  /** Absolute lift in percentage points (variant − control), e.g. +22.9. */
  deltaPp: number;
  /** Relative lift, e.g. +1.18 = +118%. */
  deltaRel: number;
  /** Pooled two-proportion z statistic. */
  z: number;
  /** Two-tailed p-value. */
  p: number;
  /** Confidence that the difference is real, as a percentage (100·(1−p)). */
  confidencePct: number;
  /** True when p < 0.05 (95% threshold). */
  significant: boolean;
  /** Scannable label, e.g. "99%+ confident", "not significant (p=0.21)". */
  label: string;
}

/** The winner on one business metric, with the delta vs control. */
export interface MetricWinner {
  metric: "auth_rate" | "rebill_rate" | "rev_per_acquired";
  /** Variant key that leads on this metric. */
  winner: string;
  /** Control's value (% for rates, £ for rev/acquired). */
  controlValue: number;
  /** Winner's value. */
  winnerValue: number;
  /** Absolute delta (winner − control), same unit as the values. */
  delta: number;
  /** Relative delta vs control (e.g. +0.21 = +21%). */
  deltaRel: number;
}

/** A ship / keep-running / inconclusive call. */
export type Recommendation = "ship" | "keep_running" | "inconclusive";

export interface Verdict {
  /** The control variant's key (everything is measured against this). */
  controlVariant: string;
  /** Per-variant, per-metric significance tests vs control (excludes control itself). */
  significance: SignificanceTest[];
  /** Best variant on each business metric. */
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
 * test for comparing two binomial proportions (auth_rate, rebill_rate).
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

/** Build one significance test of a variant's proportion vs control's. */
function buildTest(
  metric: string,
  variantSucc: number, variantTrials: number,
  controlSucc: number, controlTrials: number,
): SignificanceTest {
  const variantRate = variantTrials > 0 ? variantSucc / variantTrials : 0;
  const controlRate = controlTrials > 0 ? controlSucc / controlTrials : 0;
  const { z, p } = twoProportionZTest(variantSucc, variantTrials, controlSucc, controlTrials);

  return {
    metric,
    controlRate,
    variantRate,
    controlSuccesses: controlSucc,
    controlTrials,
    variantSuccesses: variantSucc,
    variantTrials,
    deltaPp: (variantRate - controlRate) * 100,
    deltaRel: controlRate > 0 ? (variantRate - controlRate) / controlRate : 0,
    z,
    p,
    confidencePct: (1 - p) * 100,
    significant: p < 0.05,
    label: confidenceLabel(p),
  };
}

/** Pick the leading variant on a single metric (higher is always better here). */
function buildWinner(
  metric: MetricWinner["metric"],
  control: VariantRow,
  rows: VariantRow[],
  value: (r: VariantRow) => number,
): MetricWinner {
  let best = rows[0]!;
  for (const r of rows) if (value(r) > value(best)) best = r;
  const controlValue = value(control);
  const winnerValue = value(best);
  return {
    metric,
    winner: best.variant,
    controlValue,
    winnerValue,
    delta: winnerValue - controlValue,
    deltaRel: controlValue !== 0 ? (winnerValue - controlValue) / controlValue : 0,
  };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** A "thin" arm: too few rebill attempts to trust the rebill signal. */
const MIN_REBILL_TRIALS = 200;
/** A "thin" arm overall: too few acquisitions to trust £/acquired. */
const MIN_APPS_ACQUIRED = 1000;

/**
 * Produce the full business verdict from per-variant rows.
 *
 * Significance is tested on the two key proportions (auth_rate, rebill_rate)
 * for every non-control variant vs control. The recommendation is deliberately
 * conservative: we only say "ship" when an arm both wins on the money metric
 * (rev/acquired) AND has a statistically significant edge on a driver
 * (auth or rebill) with adequate sample — never on thin data or a £ lead alone.
 */
export function buildVerdict(rows: VariantRow[]): Verdict {
  const control = rows.find((r) => r.isControl);
  if (!control) throw new Error("buildVerdict: no control row (exactly one row must have isControl=true)");

  const variants = rows.filter((r) => !r.isControl);

  // --- significance: auth_rate and rebill_rate, each variant vs control ---
  const significance: SignificanceTest[] = [];
  for (const v of variants) {
    // auth_rate denominator = paid + failed (first-payment attempts).
    significance.push(
      buildTest(
        `auth_rate · ${v.variant}`,
        v.firstPaid, v.firstPaid + v.firstFailed,
        control.firstPaid, control.firstPaid + control.firstFailed,
      ),
    );
    // rebill_rate denominator = rebill + rebill_failed (renewal attempts).
    significance.push(
      buildTest(
        `rebill_rate · ${v.variant}`,
        v.rebillOk, v.rebillOk + v.rebillFail,
        control.rebillOk, control.rebillOk + control.rebillFail,
      ),
    );
  }

  // --- winners per business metric ---
  const winners: MetricWinner[] = [
    buildWinner("auth_rate", control, rows, (r) => r.authRate),
    buildWinner("rebill_rate", control, rows, (r) => r.rebillRate),
    buildWinner("rev_per_acquired", control, rows, (r) => r.revPerAcquired),
  ];

  // --- recommendation ---
  const revWinner = winners.find((w) => w.metric === "rev_per_acquired")!;
  const revWinnerRow = rows.find((r) => r.variant === revWinner.winner)!;
  const revWinnerBeatsControl = revWinner.winner !== control.variant;

  // Is the money winner's edge backed by a SIGNIFICANT, adequately-sampled
  // driver (auth or rebill) in its favour?
  const winnerSigTests = significance.filter((s) => s.metric.endsWith(`· ${revWinner.winner}`));
  const hasSignificantPositiveDriver = winnerSigTests.some(
    (s) => s.significant && s.deltaPp > 0 &&
      // require real sample behind whichever rate carried it
      (s.metric.startsWith("rebill_rate") ? s.variantTrials >= MIN_REBILL_TRIALS : s.variantTrials >= 200),
  );
  const winnerHasSample = revWinnerRow.appsAcquired >= MIN_APPS_ACQUIRED;

  let recommendation: Recommendation;
  let recommendedVariant: string | null;
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

  const narrative = buildNarrative(control, rows, significance, winners, recommendation, recommendedVariant);

  return {
    controlVariant: control.variant,
    significance,
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
 * caveat, and explicit small-sample flags. Mirrors the honest, nuanced house
 * style — never over-claims a winner on thin data.
 */
function buildNarrative(
  control: VariantRow,
  rows: VariantRow[],
  significance: SignificanceTest[],
  winners: MetricWinner[],
  recommendation: Recommendation,
  recommendedVariant: string | null,
): string {
  const lines: string[] = [];
  const revWinner = winners.find((w) => w.metric === "rev_per_acquired")!;
  const rebillWinner = winners.find((w) => w.metric === "rebill_rate")!;
  const authWinner = winners.find((w) => w.metric === "auth_rate")!;

  // --- headline on the money metric ---
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

  // --- the cheaper-plan tradeoff, read off the data ---
  // Find the arm with the biggest positive rebill lift vs control — typically
  // the cheapest plan: easier to collect on renewal, but it caps £/customer.
  const rebillTests = significance.filter((s) => s.metric.startsWith("rebill_rate"));
  const bestRebill = rebillTests.reduce<SignificanceTest | null>(
    (best, t) => (best === null || t.deltaPp > best.deltaPp ? t : best),
    null,
  );
  if (bestRebill && bestRebill.deltaPp > 0) {
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

  // --- auth_rate: usually small + noisy, say so when it is ---
  const authTests = significance.filter((s) => s.metric.startsWith("auth_rate"));
  const anyAuthSignificant = authTests.some((t) => t.significant);
  if (authTests.length > 0) {
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

  // --- LTV horizon: the call hinges on it ---
  lines.push(
    `The call hinges on the LTV horizon. £/acquired here is collected-to-date, not lifetime: a cheaper ` +
    `plan that renews more reliably can overtake a pricier one over enough billing cycles, so a £ lead ` +
    `today is not a settled LTV verdict. Re-read once each arm has several rebill cycles behind it.`,
  );

  // --- explicit sample-size flags ---
  const thin = rows.filter((r) => r.appsAcquired < MIN_APPS_ACQUIRED || (r.rebillOk + r.rebillFail) < MIN_REBILL_TRIALS);
  if (thin.length > 0) {
    const flags = thin.map(
      (r) => `${r.variant} (${r.appsAcquired.toLocaleString()} apps, ${(r.rebillOk + r.rebillFail).toLocaleString()} rebill attempts)`,
    );
    lines.push(`Sample caveat — thin arms, treat their deltas as directional: ${flags.join("; ")}.`);
  }

  // --- methodological caveat on rebill_failed ---
  lines.push(
    `Caveat: rebill_failed is attempt-level (PSP retries inflate it), so rebill_rate is a directional ` +
    `collection signal, not an exact per-subscription rate — confirm a winner against the deduped (by subscriptionId) rate before shipping.`,
  );

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
