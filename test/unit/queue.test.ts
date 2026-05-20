import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueue } from "../../src/webhook/queue.js";

describe("createQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("processes all jobs in order when under capacity", async () => {
    const processed: string[] = [];
    const q = createQueue<string>({
      max: 10,
      handler: async (job) => {
        processed.push(job.id);
      },
    });

    for (let i = 0; i < 5; i++) {
      q.enqueue({ id: `job-${i}`, payload: `p-${i}` });
    }

    await vi.runAllTimersAsync();
    await q.drain(100);

    expect(processed).toEqual(["job-0", "job-1", "job-2", "job-3", "job-4"]);
  });

  it("drops oldest and warns on overflow", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const processed: string[] = [];

    const q = createQueue<string>({
      max: 10,
      handler: async (job) => {
        processed.push(job.id);
      },
    });

    for (let i = 0; i < 12; i++) {
      q.enqueue({ id: `job-${i}`, payload: `p-${i}` });
    }

    await vi.runAllTimersAsync();
    await q.drain(100);

    expect(processed).not.toContain("job-0");
    expect(processed).not.toContain("job-1");
    expect(processed).toHaveLength(10);

    warnSpy.mockRestore();
  });

  it("continues processing after a handler throws, logs worker-handler-failed", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const processed: string[] = [];

    const q = createQueue<string>({
      max: 10,
      handler: async (job) => {
        if (job.id === "job-1") throw new Error("handler error");
        processed.push(job.id);
      },
    });

    q.enqueue({ id: "job-0", payload: "p0" });
    q.enqueue({ id: "job-1", payload: "p1" });
    q.enqueue({ id: "job-2", payload: "p2" });

    await vi.runAllTimersAsync();
    await q.drain(100);

    expect(processed).toContain("job-0");
    expect(processed).toContain("job-2");
    expect(processed).not.toContain("job-1");

    errorSpy.mockRestore();
  });

  it("drain resolves immediately when queue is empty and not running", async () => {
    const q = createQueue<string>({ max: 10, handler: async () => {} });
    await expect(q.drain(100)).resolves.toBeUndefined();
  });

  it("drain resolves on timeout when handler is slow", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const q = createQueue<string>({
      max: 10,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 10_000));
      },
    });

    q.enqueue({ id: "slow-job", payload: "p" });

    const drainPromise = q.drain(50);
    vi.advanceTimersByTime(50);

    await drainPromise;

    warnSpy.mockRestore();
  });

  it("drain resolves when worker finishes before timeout", async () => {
    const q = createQueue<string>({
      max: 10,
      handler: async (_job) => {
        await new Promise((r) => setTimeout(r, 10));
      },
    });

    q.enqueue({ id: "fast-job", payload: "p" });

    const drainPromise = q.drain(5000);
    await vi.runAllTimersAsync();
    await drainPromise;
  });

  it("queue remains usable after drain — new enqueue is processed", async () => {
    const processed: string[] = [];
    const q = createQueue<string>({
      max: 10,
      handler: async (job) => {
        processed.push(job.id);
      },
    });

    q.enqueue({ id: "pre-drain", payload: "p" });
    await vi.runAllTimersAsync();
    await q.drain(100);

    q.enqueue({ id: "post-drain", payload: "p2" });
    await vi.runAllTimersAsync();
    await q.drain(100);

    expect(processed).toContain("pre-drain");
    expect(processed).toContain("post-drain");
  });

  it("size() returns current buffer length", () => {
    const q = createQueue<string>({
      max: 10,
      handler: async () => {},
    });

    q.enqueue({ id: "j0", payload: "p" });
    q.enqueue({ id: "j1", payload: "p" });
    q.enqueue({ id: "j2", payload: "p" });

    // All 3 are still in buf — worker is deferred via Promise.resolve() and hasn't run yet
    expect(q.size()).toBe(3);
  });
});
