/**
 * A hard wall-clock budget for work on a render path.
 *
 * WHY: lib/metabase.ts bounds every Metabase request with AbortSignal.timeout
 * because an unbounded read there once held the whole response open until the
 * platform's max duration expired, and the user got a 504 instead of an empty
 * state. A Postgres round-trip on the same render path needs the same
 * discipline, but the driver takes no abort signal — so the budget has to be
 * enforced by the caller.
 *
 * WHAT THIS DOES NOT DO: it does not cancel the work. The query keeps running
 * on its connection until the driver gives up. What it bounds is how long the
 * RESPONSE waits, which is the property the render path actually needs.
 */

/** Run `work` under a wall-clock budget. On expiry this rejects with a clear,
 *  greppable Error, so a caller that already try/catches a failure degrades on
 *  a stall exactly as it does on any other error — fast, and without taking the
 *  page down. A late rejection from `work` stays handled by the race, so a slow
 *  failure after the budget expires cannot surface as an unhandled rejection. */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  // clearTimeout on settle so a resolved read never leaves a pending timer
  // holding a serverless invocation open past its own work.
  return Promise.race([work, budget]).finally(() => clearTimeout(timer)) as Promise<T>;
}
