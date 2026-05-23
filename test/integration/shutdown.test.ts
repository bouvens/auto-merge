import type pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeExitStub, makeShutdown } from "../../src/shutdown.js";
import type { MultiQueue } from "../../src/webhook/multiQueue.js";

function stubProcessExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, "exit").mockImplementation(makeExitStub() as never);
}

function makeLog(): pino.Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as pino.Logger;
}

function makeQueue(opts: { neverDrain?: boolean }): MultiQueue<unknown> {
  return {
    enqueue: vi.fn(),
    size: vi.fn().mockReturnValue(0),
    keyCount: vi.fn().mockReturnValue(0),
    drain: vi.fn().mockImplementation((_timeoutMs: number) => {
      if (!opts.neverDrain) return Promise.resolve();
      return new Promise<void>(() => {});
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("shutdown ordering", () => {
  it("calls cronHandle.stop → defaultLoaderStop → app.close → multiQueue.drain in order", async () => {
    const exitSpy = stubProcessExit();
    const log = makeLog();
    const callOrder: string[] = [];

    const cronHandle = {
      stop: vi.fn(async () => {
        callOrder.push("cron.stop");
      }),
    };
    const defaultLoaderStop = vi.fn(() => {
      callOrder.push("defaultLoader.stop");
    });
    const app = {
      close: vi.fn(async () => {
        callOrder.push("app.close");
      }),
    };
    const queue = makeQueue({});
    (queue.drain as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("queue.drain");
    });

    const shutdown = makeShutdown({
      app: app as never,
      cronHandle,
      multiQueue: queue,
      defaultLoaderStop,
      log,
      shutdownTimeoutMs: 1000,
    });

    await expect(shutdown("SIGTERM")).rejects.toThrow("exit:0");
    expect(callOrder).toEqual([
      "cron.stop",
      "defaultLoader.stop",
      "app.close",
      "queue.drain",
    ]);
    expect(defaultLoaderStop).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe("drain timeout exits 0", () => {
  it("exits 0 when drain times out and logs multi_queue_drain_timeout", async () => {
    const exitSpy = stubProcessExit();
    const log = makeLog();

    const queue: MultiQueue<unknown> = {
      enqueue: vi.fn(),
      size: vi.fn().mockReturnValue(1),
      keyCount: vi.fn().mockReturnValue(1),
      drain: vi.fn().mockImplementation((_timeoutMs: number) => {
        log.warn(
          { event: "multi_queue_drain_timeout", remaining_keys: ["inst/owner/repo"], remaining_total: 1, timeout_ms: _timeoutMs },
          "drain-timeout",
        );
        return Promise.resolve();
      }),
    };

    const shutdown = makeShutdown({
      app: undefined,
      cronHandle: undefined,
      multiQueue: queue,
      defaultLoaderStop: vi.fn(),
      log,
      shutdownTimeoutMs: 50,
    });

    await expect(shutdown("SIGTERM")).rejects.toThrow("exit:0");
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "multi_queue_drain_timeout" }),
      "drain-timeout",
    );
  });
});

describe("cron disabled (no-op handle)", () => {
  it("no-op cronHandle.stop still results in clean shutdown", async () => {
    const exitSpy = stubProcessExit();
    const log = makeLog();
    const cronHandle = { stop: vi.fn(async () => {}) };
    const queue = makeQueue({});

    const shutdown = makeShutdown({
      app: undefined,
      cronHandle,
      multiQueue: queue,
      defaultLoaderStop: vi.fn(),
      log,
      shutdownTimeoutMs: 100,
    });

    await expect(shutdown("SIGTERM")).rejects.toThrow("exit:0");
    expect(cronHandle.stop).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe("double SIGTERM idempotency", () => {
  it("cronHandle.stop called once; second invocation logs shutdown_already_in_progress", async () => {
    const exitSpy = stubProcessExit();
    const log = makeLog();
    const cronHandle = { stop: vi.fn(async () => {}) };
    const defaultLoaderStop = vi.fn();
    const queue = makeQueue({});

    const shutdown = makeShutdown({
      app: undefined,
      cronHandle,
      multiQueue: queue,
      defaultLoaderStop,
      log,
      shutdownTimeoutMs: 100,
    });

    const first = shutdown("SIGTERM");
    const second = shutdown("SIGTERM");

    await expect(first).rejects.toThrow("exit:0");
    await expect(second).resolves.toBeUndefined();

    expect(cronHandle.stop).toHaveBeenCalledOnce();
    expect(defaultLoaderStop).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "shutdown_already_in_progress" }),
      "shutdown",
    );
  });
});
