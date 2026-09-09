/**
 * The two pure rules the SRM early warning depends on.
 *
 * Both used to live inline — one in the results route, one in LiveResults — and
 * were re-typed a third time in the tests. That meant the tests pinned a COPY
 * of the logic, so a change to the real code path could go green. They are
 * exported from here so the route, the component and the tests all read the
 * same implementation.
 */

/** An arm as the experiment declares it: the flag's variant key and its
 *  configured share of traffic. */
export interface DeclaredArm {
  key: string;
  rolloutPercentage: number;
}

/** An arm as the assignment events observed it. */
export interface ObservedCount {
  variant: string;
  visitors: number;
}

/** A declared arm matched to what it actually received. */
export interface AlignedArm {
  variant: string;
  visitors: number;
  weight: number;
}

/**
 * Order observed counts to match the experiment's DECLARED arms, so the
 * expected split lines up arm-for-arm for the chi-square.
 *
 * The alignment is driven by `declared`, never by what the query returned. An
 * arm with no assignments yet contributes a zero instead of being dropped —
 * that is the whole point. The dangerous failure is an arm going dark: if it
 * vanished from the list for being absent, the remaining arms could show a
 * perfect split while one arm served nobody. A retired arm that still has
 * events but is no longer declared is ignored, because it is no longer part of
 * the split being tested.
 */
export function alignArmsToDeclared(
  declared: DeclaredArm[],
  observed: ObservedCount[],
): AlignedArm[] {
  return declared.map((v) => ({
    variant: v.key,
    visitors: observed.find((c) => c.variant === v.key)?.visitors ?? 0,
    weight: v.rolloutPercentage,
  }));
}

/**
 * Is this an A/A test, judged from the data rather than a flag?
 *
 * Every arm points at the SAME storefront slug, so the arms are identical by
 * construction and no difference between them can be real. Two arms are the
 * minimum — a single arm is not an A/A, it is a single arm.
 */
export function isAA(themeSlugs: string[]): boolean {
  return themeSlugs.length >= 2 && new Set(themeSlugs).size === 1;
}

/** The window an SRM split actually covers, as shipped by the results route. */
export interface SrmWindow {
  oldestTs: string | null;
  newestTs: string | null;
  retentionDays: number;
  capped: boolean;
}

/** Format one assignment timestamp for the window line. Fixed locale so the
 *  string does not drift with whoever is reading. */
export function shortDate(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ts
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * Describe the window the split actually covers.
 *
 * retentionDays is the CEILING, not the coverage. A young experiment, or one
 * whose project hit the row cap, can hold far less than that — saying "the last
 * 7 days" there overstates what the number is based on, which is exactly the
 * impression an early warning must not give. The real span is already computed
 * and shipped, so use it, and fall back to the ceiling only when there is
 * genuinely no timestamp to show.
 */
export function describeWindow(win: SrmWindow): string {
  const span =
    win.oldestTs && win.newestTs
      ? shortDate(win.oldestTs) === shortDate(win.newestTs)
        ? `on ${shortDate(win.newestTs)}`
        : `from ${shortDate(win.oldestTs)} to ${shortDate(win.newestTs)}`
      : `over the last ${win.retentionDays} days`;
  return win.capped
    ? `${span} (capped — older assignments have been dropped, so this window is shorter than the ${win.retentionDays}-day retention)`
    : span;
}
