import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../../src/log.js";
import { createMultiQueue } from "../../src/webhook/multiQueue.js";
import type { Job } from "../../src/webhook/queue.js";

const makeNotify = () => ({ notify: vi.fn().mockResolvedValue(undefined) });

describe("createMultiQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("per-key FIFO serialization: jobs on same key complete in enqueue order", async () => {
    const completedA: string[] = [];
    const completedB: string[] = [];
    const releaseA: Array<() => void> = [];
    const releaseB: Array<() => void> = [];

    const handler = async (job: Job<{ key: string }>): Promise<void> => {
      if (job.payload.key === "A") {
        await new Promise<void>((r) => releaseA.push(r));
        completedA.push(job.id);
      } else {
        await new Promise<void>((r) => releaseB.push(r));
        completedB.push(job.id);
      }
    };

    const q = createMultiQueue({ perKeyMax: 10, globalMax: 100, handler, notify: makeNotify() });
    q.enqueue("A", { id: "A1", payload: { key: "A" } });
    q.enqueue("A", { id: "A2", payload: { key: "A" } });
    q.enqueue("B", { id: "B1", payload: { key: "B" } });
    q.enqueue("B", { id: "B2", payload: { key: "B" } });

    // Kick off workers.
    await vi.runAllTimersAsync();

    // Release A1 and B1 first.
    releaseA[0]?.();
    releaseB[0]?.();
    await vi.runAllTimersAsync();

    // Release A2 and B2.
    releaseA[1]?.();
    releaseB[1]?.();
    await vi.runAllTimersAsync();

    expect(completedA).toEqual(["A1", "A2"]);
    expect(completedB).toEqual(["B1", "B2"]);
  });

  it("cross-key parallelism: both handlers start before either resolves", async () => {
    let inflight = 0;
    let peakInflight = 0;
    const releases: Array<() => void> = [];

    const handler = async (): Promise<void> => {
      inflight++;
      peakInflight = Math.max(peakInflight, inflight);
      await new Promise<void>((r) => releases.push(r));
      inflight--;
    };

    const q = createMultiQueue({ perKeyMax: 10, globalMax: 100, handler, notify: makeNotify() });
    q.enqueue("key-A", { id: "j-A", payload: {} });
    q.enqueue("key-B", { id: "j-B", payload: {} });

    await vi.runAllTimersAsync();

    // Both lanes should be in-flight simultaneously.
    expect(peakInflight).toBe(2);

    for (const r of releases) r();
    await vi.runAllTimersAsync();
  });

  it("per-key drop-oldest + notify: 3rd job on perKeyMax=2 drops job-0", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const notifyMock = makeNotify();
    const processed: string[] = [];

    const q = createMultiQueue({
      perKeyMax: 2,
      globalMax: 100,
      handler: async (job: Job<unknown>) => {
        processed.push(job.id);
      },
      notify: notifyMock,
    });

    q.enqueue("repo-A", { id: "job-0", payload: {} });
    q.enqueue("repo-A", { id: "job-1", payload: {} });
    q.enqueue("repo-A", { id: "job-2", payload: {} });

    await vi.runAllTimersAsync();
    await q.drain(100);
    await vi.runAllTimersAsync();

    expect(processed).not.toContain("job-0");
    expect(processed).toContain("job-1");
    expect(processed).toContain("job-2");

    await vi.runAllTimersAsync();
    expect(notifyMock.notify).toHaveBeenCalledWith({
      kind: "queue_overflow",
      key: "repo-A",
      dropped_id: "job-0",
    });

    warnSpy.mockRestore();
  });

  it("global cap drops from largest lane: 4th enqueue with globalMax=3 drops from key-A", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const notifyMock = makeNotify();

    // Handler blocks so jobs stay in-flight and buf stays populated.
    const releases: Array<() => void> = [];
    const handler = async (): Promise<void> => {
      await new Promise<void>((r) => releases.push(r));
    };

    const q = createMultiQueue({
      perKeyMax: 10,
      globalMax: 3,
      handler,
      notify: notifyMock,
    });

    // Enqueue 2 on key-A (first one will start running immediately via microtask).
    q.enqueue("key-A", { id: "A0", payload: {} });
    // Flush microtasks so A0 is dequeued from buf and starts running — buf for key-A is now empty.
    await Promise.resolve();
    // A0 is running, buf is empty; enqueue A1 and A2 so key-A buf has 2.
    q.enqueue("key-A", { id: "A1", payload: {} });
    q.enqueue("key-A", { id: "A2", payload: {} });

    // Flush microtasks again (runLane for A1/A2 queued but lane is running so they stay buffered).
    await Promise.resolve();

    // key-A has buf=[A1, A2] (2 jobs), key-B doesn't exist yet. size()=2 < globalMax=3.
    q.enqueue("key-B", { id: "B0", payload: {} });
    await Promise.resolve();
    // B0 starts running immediately. buf for key-B is now empty. size()=2 (A1, A2 in key-A buf).

    // Now enqueue B1 which puts total size at 3.
    q.enqueue("key-B", { id: "B1", payload: {} });
    await Promise.resolve();
    // size()=3 (A1, A2 in key-A; B1 in key-B). Exactly at globalMax, no drop yet.

    // 4th enqueue: size() will be >= globalMax → drop from key-A (largest buf=2 vs key-B buf=1).
    q.enqueue("key-B", { id: "B2", payload: {} });
    await Promise.resolve();

    // key-A buf should have had A1 dropped (it's the oldest in the largest lane).
    expect(notifyMock.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "queue_overflow", key: "key-A" }),
    );

    // Release all blocked handlers.
    for (const r of releases) r();
    await vi.runAllTimersAsync();
    warnSpy.mockRestore();
  });

  it("idle lane GC and recreation: keyCount drops to 0 after drain and rises again on re-enqueue", async () => {
    const q = createMultiQueue({
      perKeyMax: 10,
      globalMax: 100,
      handler: async () => {},
      notify: makeNotify(),
    });

    q.enqueue("key-A", { id: "j0", payload: {} });

    // Allow microtasks + runLane to complete.
    await vi.runAllTimersAsync();
    const drainPromise = q.drain(100);
    await vi.runAllTimersAsync();
    await drainPromise;

    expect(q.keyCount()).toBe(0);

    q.enqueue("key-A", { id: "j1", payload: {} });
    expect(q.keyCount()).toBe(1);

    await vi.runAllTimersAsync();
    const drainPromise2 = q.drain(100);
    await vi.runAllTimersAsync();
    await drainPromise2;
  });

  it("drain global timeout: resolves after timeoutMs when handler never completes", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    const q = createMultiQueue({
      perKeyMax: 10,
      globalMax: 100,
      handler: async () => {
        await new Promise((_r) => {
          // Never resolves — simulates a stuck handler to test drain timeout.
        });
      },
      notify: makeNotify(),
    });

    q.enqueue("key-stuck", { id: "stuck-job", payload: {} });

    const drainPromise = q.drain(50);
    await vi.advanceTimersByTimeAsync(50);
    await drainPromise;

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "multi_queue_drain_timeout",
        remaining_keys: ["key-stuck"],
      }),
      "drain-timeout",
    );

    warnSpy.mockRestore();
  });

  it("concurrent drain isolation: two drain calls resolve at their own independent timeouts", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    const q = createMultiQueue({
      perKeyMax: 10,
      globalMax: 100,
      handler: async () => {
        await new Promise((_r) => {
          // Never resolves — both drain calls should fire independently.
        });
      },
      notify: makeNotify(),
    });

    q.enqueue("key-X", { id: "j0", payload: {} });

    const resolved: number[] = [];
    const drain50 = q.drain(50).then(() => {
      resolved.push(50);
    });
    const drain100 = q.drain(100).then(() => {
      resolved.push(100);
    });

    await vi.advanceTimersByTimeAsync(50);
    await drain50;
    expect(resolved).toEqual([50]);

    await vi.advanceTimersByTimeAsync(50);
    await drain100;
    expect(resolved).toEqual([50, 100]);

    warnSpy.mockRestore();
  });
});
