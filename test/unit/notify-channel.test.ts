import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotifyEvent } from "../../src/notify/channel.js";

// Reset module state between tests to avoid shared log singleton side-effects.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("NoopChannel", () => {
  it("resolves without throwing for queue_overflow event", async () => {
    const { NoopChannel } = await import("../../src/notify/channel.js");
    const ch = new NoopChannel();
    const event: NotifyEvent = {
      kind: "queue_overflow",
      key: "42/owner/repo",
      dropped_id: "job-123",
    };
    await expect(ch.notify(event)).resolves.toBeUndefined();
  });

  it("resolves without throwing for cascade_conflict event", async () => {
    const { NoopChannel } = await import("../../src/notify/channel.js");
    const ch = new NoopChannel();
    const event: NotifyEvent = {
      kind: "cascade_conflict",
      run_id: "run-1",
      repo: "owner/repo",
      src: "main",
      tgt: "release",
      pr_url: "https://github.com/owner/repo/pull/1",
    };
    await expect(ch.notify(event)).resolves.toBeUndefined();
  });

  it("resolves without throwing for protection_blocked event", async () => {
    const { NoopChannel } = await import("../../src/notify/channel.js");
    const ch = new NoopChannel();
    const event: NotifyEvent = {
      kind: "protection_blocked",
      run_id: "run-2",
      repo: "owner/repo",
      src: "main",
      tgt: "dev",
      pr_url: "https://github.com/owner/repo/pull/2",
      rule: "required_status_checks",
    };
    await expect(ch.notify(event)).resolves.toBeUndefined();
  });

  it("resolves without throwing for permission_error event", async () => {
    const { NoopChannel } = await import("../../src/notify/channel.js");
    const ch = new NoopChannel();
    const event: NotifyEvent = {
      kind: "permission_error",
      run_id: "run-3",
      repo: "owner/repo",
      src: "main",
      tgt: "release",
      endpoint: "merges",
      status: 403,
      missing_permission: "contents:write",
    };
    await expect(ch.notify(event)).resolves.toBeUndefined();
  });

  it("emits a pino info log with event field matching notify_{kind}", async () => {
    const { log } = await import("../../src/log.js");
    const infoSpy = vi.spyOn(log, "info");

    const { NoopChannel } = await import("../../src/notify/channel.js");
    const ch = new NoopChannel();
    const event: NotifyEvent = {
      kind: "queue_overflow",
      key: "42/owner/repo",
      dropped_id: "job-456",
    };
    await ch.notify(event);

    expect(infoSpy).toHaveBeenCalledOnce();
    const [logObj] = infoSpy.mock.calls[0] as [{ event: string }];
    expect(logObj.event).toBe("notify_queue_overflow");
  });

  it("is constructible with no arguments", async () => {
    const { NoopChannel } = await import("../../src/notify/channel.js");
    expect(() => new NoopChannel()).not.toThrow();
  });
});

describe("NotificationChannel interface (type-level)", () => {
  it("NoopChannel satisfies NotificationChannel", async () => {
    const { NoopChannel } = await import("../../src/notify/channel.js");
    // If this compiles, the interface is satisfied.
    const ch = new NoopChannel();
    expect(typeof ch.notify).toBe("function");
  });
});
