import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/cascade/sourceShaDedup.js", () => ({
  sourceShaDedup: { seen: vi.fn(), mark: vi.fn() },
}));

import { sourceShaDedup } from "../../src/cascade/sourceShaDedup.js";
import type { CascadeJob } from "../../src/cascade/orchestrator.js";
import { log } from "../../src/log.js";
import type { MultiQueue } from "../../src/webhook/multiQueue.js";
import { handleDispatchEvent } from "../../src/dispatch/handler.js";

function makeQueue(): MultiQueue<CascadeJob> & {
  calls: Array<{ key: string; id: string; payload: unknown }>;
} {
  const calls: Array<{ key: string; id: string; payload: unknown }> = [];
  return {
    calls,
    enqueue(key, job) {
      calls.push({ key, id: job.id, payload: job.payload });
    },
    drain: async () => undefined,
    size: () => calls.length,
    keyCount: () => calls.length,
    clearByInstallation: () => 0,
  };
}

interface PartialDispatchPayload {
  action?: string;
  branch?: string;
  client_payload?: Record<string, unknown> | null;
  sender?: { login: string };
  installation?: { id: number } | null;
  repository?: { name: string; owner: { login: string } };
}

function makeCtx(payload: PartialDispatchPayload, id = "delivery-1") {
  return {
    id,
    payload: {
      action: "auto-merge",
      branch: "main",
      client_payload: null,
      sender: { login: "user1" },
      installation: { id: 42 },
      repository: { name: "widgets", owner: { login: "acme" } },
      ...payload,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});

describe("handleDispatchEvent (D-09, D-10)", () => {
  it("action !== 'auto-merge' → skip + log dispatch_skipped", async () => {
    const q = makeQueue();
    const infoSpy = vi.spyOn(log, "info");
    await handleDispatchEvent(makeCtx({ action: "other" }), { queue: q });
    expect(q.calls).toHaveLength(0);
    const events = infoSpy.mock.calls.map((c) => (c[0] as { event?: string })?.event);
    expect(events).toContain("dispatch_skipped");
    const skipped = infoSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === "dispatch_skipped",
    );
    expect((skipped?.[0] as { action?: string })?.action).toBe("other");
  });

  it("missing installation.id → skip + log dispatch_missing_installation", async () => {
    const q = makeQueue();
    const warnSpy = vi.spyOn(log, "warn");
    await handleDispatchEvent(makeCtx({ installation: null }), { queue: q });
    expect(q.calls).toHaveLength(0);
    const events = warnSpy.mock.calls.map((c) => (c[0] as { event?: string })?.event);
    expect(events).toContain("dispatch_missing_installation");
  });

  it("valid dispatch → enqueue CascadeJob{source:'dispatch'} with correct key and fields", async () => {
    const q = makeQueue();
    const infoSpy = vi.spyOn(log, "info");
    await handleDispatchEvent(
      makeCtx({ client_payload: { note: "manual run" } }, "delivery-valid"),
      { queue: q },
    );
    expect(q.calls).toHaveLength(1);
    const entry = q.calls[0]!;
    expect(entry.key).toBe("42/acme/widgets");
    expect(entry.id).toBe("delivery-valid");
    expect(entry.payload).toMatchObject({
      source: "dispatch",
      installation_id: 42,
      owner: "acme",
      repo: "widgets",
      after: null,
      sender: { login: "user1" },
    });
    const events = infoSpy.mock.calls.map((c) => (c[0] as { event?: string })?.event);
    expect(events).toContain("dispatch_received");
  });

  it("loop-prevention NOT applied: bot sender → cascade still enqueued", async () => {
    // Push handler would skip on bot sender; dispatch handler must not (D-10 exemption).
    const q = makeQueue();
    await handleDispatchEvent(
      makeCtx({ sender: { login: "my-app[bot]" } }),
      { queue: q },
    );
    expect(q.calls).toHaveLength(1);
    expect((q.calls[0]!.payload as { source: string }).source).toBe("dispatch");
  });

  it("sourceShaDedup NOT called inside dispatch handler (dedup is orchestrator responsibility)", async () => {
    const q = makeQueue();
    const seenSpy = vi.mocked(sourceShaDedup.seen);
    const markSpy = vi.mocked(sourceShaDedup.mark);
    await handleDispatchEvent(makeCtx({}), { queue: q });
    expect(seenSpy).not.toHaveBeenCalled();
    expect(markSpy).not.toHaveBeenCalled();
  });

  it("client_payload preserved verbatim in dispatch_received log", async () => {
    const q = makeQueue();
    const infoSpy = vi.spyOn(log, "info");
    const payload = { note: "manual run", env: "staging" };
    await handleDispatchEvent(makeCtx({ client_payload: payload }), { queue: q });
    const received = infoSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === "dispatch_received",
    );
    expect((received?.[0] as { client_payload?: unknown })?.client_payload).toEqual(payload);
  });
});
