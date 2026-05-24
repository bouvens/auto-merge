import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../../src/log.js";
import type { NotificationChannel, NotifyEvent } from "../../src/notify/channel.js";
import { MultiChannel } from "../../src/notify/dispatcher.js";

class StubChannel implements NotificationChannel {
  notify = vi.fn(async (_event: NotifyEvent): Promise<void> => {});
}

const conflictEvent = (installationId?: number): NotifyEvent => ({
  kind: "cascade_conflict",
  run_id: "run-1",
  repo: "owner/repo",
  src: "main",
  tgt: "release",
  pr_url: "https://example.invalid/pull/1",
  ...(installationId !== undefined ? { installation_id: installationId } : {}),
});

const overflowEvent = (key: string): NotifyEvent => ({
  kind: "queue_overflow",
  key,
  dropped_id: "job-1",
});

describe("MultiChannel suppression", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(log, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards to all channels when no options given (legacy ctor)", async () => {
    const a = new StubChannel();
    const b = new StubChannel();
    const dispatcher = new MultiChannel([a, b]);
    await dispatcher.notify(conflictEvent(42));
    expect(a.notify).toHaveBeenCalledTimes(1);
    expect(b.notify).toHaveBeenCalledTimes(1);
  });

  it("forwards when options = {} (empty options)", async () => {
    const a = new StubChannel();
    const dispatcher = new MultiChannel([a], {});
    await dispatcher.notify(conflictEvent(42));
    expect(a.notify).toHaveBeenCalledTimes(1);
  });

  it("forwards when suppressionCheck returns false", async () => {
    const a = new StubChannel();
    const dispatcher = new MultiChannel([a], { suppressionCheck: () => false });
    await dispatcher.notify(conflictEvent(42));
    expect(a.notify).toHaveBeenCalledTimes(1);
  });

  it("suppresses cascade_conflict when suppressionCheck(id) returns true", async () => {
    const a = new StubChannel();
    const b = new StubChannel();
    const dispatcher = new MultiChannel([a, b], { suppressionCheck: (id) => id === 42 });
    await dispatcher.notify(conflictEvent(42));
    expect(a.notify).not.toHaveBeenCalled();
    expect(b.notify).not.toHaveBeenCalled();
    const calls = debugSpy.mock.calls as unknown as Array<[Record<string, unknown>, string]>;
    const suppressionCall = calls.find(
      ([payload]) => payload && payload.event === "notify_suppressed_onboarding",
    );
    expect(suppressionCall).toBeDefined();
    expect(suppressionCall?.[0]).toMatchObject({
      event: "notify_suppressed_onboarding",
      kind: "cascade_conflict",
      installation_id: 42,
    });
  });

  it("forwards cascade_conflict when suppressionCheck(id) returns false for that id", async () => {
    const a = new StubChannel();
    const dispatcher = new MultiChannel([a], { suppressionCheck: (id) => id === 42 });
    await dispatcher.notify(conflictEvent(99));
    expect(a.notify).toHaveBeenCalledTimes(1);
  });

  it("suppresses queue_overflow when installation_id parsed from key prefix matches", async () => {
    const a = new StubChannel();
    const dispatcher = new MultiChannel([a], { suppressionCheck: (id) => id === 42 });
    await dispatcher.notify(overflowEvent("42/acme/api"));
    expect(a.notify).not.toHaveBeenCalled();
  });

  it("forwards queue_overflow when installation_id from key prefix does not match", async () => {
    const a = new StubChannel();
    const dispatcher = new MultiChannel([a], { suppressionCheck: (id) => id === 42 });
    await dispatcher.notify(overflowEvent("99/acme/api"));
    expect(a.notify).toHaveBeenCalledTimes(1);
  });

  it("forwards queue_overflow when key has no slash (malformed)", async () => {
    const a = new StubChannel();
    const dispatcher = new MultiChannel([a], { suppressionCheck: () => true });
    await dispatcher.notify(overflowEvent("no-slash-here"));
    expect(a.notify).toHaveBeenCalledTimes(1);
  });

  it("forwards queue_overflow when key prefix is non-numeric", async () => {
    const a = new StubChannel();
    const dispatcher = new MultiChannel([a], { suppressionCheck: () => true });
    await dispatcher.notify(overflowEvent("abc/acme/api"));
    expect(a.notify).toHaveBeenCalledTimes(1);
  });

  it("forwards cascade_conflict event without installation_id field (id undefined → no suppression)", async () => {
    const a = new StubChannel();
    const dispatcher = new MultiChannel([a], { suppressionCheck: () => true });
    await dispatcher.notify(conflictEvent(undefined));
    expect(a.notify).toHaveBeenCalledTimes(1);
  });

  it("suppression applies uniformly across multiple channels", async () => {
    const a = new StubChannel();
    const b = new StubChannel();
    const c = new StubChannel();
    const dispatcher = new MultiChannel([a, b, c], { suppressionCheck: () => true });
    await dispatcher.notify(conflictEvent(42));
    expect(a.notify).not.toHaveBeenCalled();
    expect(b.notify).not.toHaveBeenCalled();
    expect(c.notify).not.toHaveBeenCalled();
  });
});
