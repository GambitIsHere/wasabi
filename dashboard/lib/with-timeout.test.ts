// ============================================================================
// withTimeout — the render-path budget for the SRM read.
// ----------------------------------------------------------------------------
// The failure this exists to prevent: a stalled Neon connection holding the
// results response open until the platform's own max duration expires, which
// is how the earlier 504 happened on the Metabase side. What matters is that a
// stall REJECTS FAST, and that a late failure from the abandoned work cannot
// resurface as an unhandled rejection.
// ============================================================================
import { describe, it, expect, vi, afterEach } from "vitest";
import { withTimeout } from "./with-timeout";

afterEach(() => vi.useRealTimers());

describe("withTimeout", () => {
  it("passes a value through untouched when the work finishes in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000, "x")).resolves.toBe(7);
  });

  it("propagates the work's own rejection rather than masking it as a timeout", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("neon exploded")), 1_000, "x"),
    ).rejects.toThrow("neon exploded");
  });

  it("rejects with a greppable, labelled error once the budget expires", async () => {
    vi.useFakeTimers();
    const stalled = new Promise<number>(() => {}); // never settles
    const raced = withTimeout(stalled, 2_500, "SRM assignment split");
    const assertion = expect(raced).rejects.toThrow(
      "SRM assignment split timed out after 2500ms",
    );
    await vi.advanceTimersByTimeAsync(2_500);
    await assertion;
  });

  it("does not expire early — at one tick under the budget it is still pending", async () => {
    vi.useFakeTimers();
    let settled = false;
    const raced = withTimeout(new Promise<number>(() => {}), 2_500, "x");
    raced.catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(2_499);
    expect(settled).toBe(false);
  });

  it("keeps a LATE rejection from the abandoned work handled", async () => {
    // The budget wins, then the real query fails a moment later. If the race
    // left that rejection unowned it would surface as an unhandled rejection
    // and, in some runtimes, take the process down — worse than the stall.
    vi.useFakeTimers();
    let failLate: (e: Error) => void = () => {};
    const slow = new Promise<number>((_r, reject) => { failLate = reject; });
    const raced = withTimeout(slow, 100, "x");
    const assertion = expect(raced).rejects.toThrow("x timed out after 100ms");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    failLate(new Error("late neon failure"));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("clears its timer on success so a resolved read leaves nothing pending", async () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await withTimeout(Promise.resolve("ok"), 5_000, "x");
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});
