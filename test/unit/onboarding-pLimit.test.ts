import { describe, expect, it } from "vitest";
import pLimit from "../../src/onboarding/pLimit.js";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("onboarding/pLimit", () => {
  it("caps concurrent in-flight tasks at the requested concurrency", async () => {
    const limit = pLimit(2);
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 5 }, () =>
      limit(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // Yield several microtask turns so all eligible tasks have a chance to start.
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
      }),
    );
    await Promise.all(tasks);
    expect(peak).toBe(2);
    expect(inFlight).toBe(0);
  });

  it("releases queued tasks in FIFO order", async () => {
    const limit = pLimit(1);
    const order: number[] = [];
    const gate = deferred<void>();

    // First task holds the single slot until we resolve `gate`.
    const first = limit(async () => {
      await gate.promise;
      order.push(0);
    });
    // Queued tasks should drain in submission order.
    const rest = [1, 2, 3, 4].map((n) =>
      limit(async () => {
        order.push(n);
      }),
    );
    gate.resolve();
    await Promise.all([first, ...rest]);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("propagates rejection to the caller without blocking subsequent tasks", async () => {
    const limit = pLimit(1);
    const boom = new Error("boom");
    await expect(limit(async () => { throw boom; })).rejects.toBe(boom);
    // Slot must be released even when the task rejected.
    const result = await limit(async () => 42);
    expect(result).toBe(42);
  });

  it("throws RangeError when concurrency is below 1", () => {
    expect(() => pLimit(0)).toThrow(RangeError);
    expect(() => pLimit(-1)).toThrow(RangeError);
  });

  it("throws RangeError when concurrency is not an integer", () => {
    expect(() => pLimit(1.5)).toThrow(RangeError);
    expect(() => pLimit(Number.NaN)).toThrow(RangeError);
  });
});
