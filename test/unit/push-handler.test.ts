import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/loader.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../../src/auth.js", () => ({ getBotIdentity: vi.fn() }));
vi.mock("../../src/cascade/sourceShaDedup.js", () => ({
  sourceShaDedup: { seen: vi.fn(), mark: vi.fn() },
}));

import { getBotIdentity } from "../../src/auth.js";
import type { PushJob } from "../../src/cascade/orchestrator.js";
import { sourceShaDedup } from "../../src/cascade/sourceShaDedup.js";
import { loadConfig } from "../../src/config/loader.js";
import { log } from "../../src/log.js";
import { handlePushEvent } from "../../src/webhook/pushHandler.js";
import type { Queue } from "../../src/webhook/queue.js";

const loadConfigMock = vi.mocked(loadConfig);
const getBotIdentityMock = vi.mocked(getBotIdentity);
const sourceShaDedupSeenMock = vi.mocked(sourceShaDedup.seen);
const sourceShaDedupMarkMock = vi.mocked(sourceShaDedup.mark);

const config = {
  main_branch: "main",
  release_branch: "release",
  dev_branch: "dev",
};

function makeQueue(): Queue<PushJob> & { calls: Array<{ id: string; payload: PushJob }> } {
  const calls: Array<{ id: string; payload: PushJob }> = [];
  return {
    calls,
    enqueue(job) {
      calls.push({ id: job.id, payload: job.payload });
    },
    drain: async () => undefined,
    size: () => calls.length,
  };
}

interface PartialPushPayload {
  ref?: string;
  created?: boolean;
  deleted?: boolean;
  before?: string;
  after?: string;
  installation?: { id: number } | null;
  sender?: { login: string };
  repository?: { name: string; owner: { login: string } };
  head_commit?: null | {
    id: string;
    message: string;
    author: { name?: string; email: string; username?: string | null };
  };
}

function makeCtx(payload: PartialPushPayload, id = "delivery-1") {
  return {
    id,
    payload: {
      ref: "refs/heads/main",
      created: false,
      deleted: false,
      before: "before123",
      after: "after4567",
      installation: { id: 42 },
      sender: { login: "user" },
      repository: { name: "widgets", owner: { login: "acme" } },
      head_commit: {
        id: "after4567",
        message: "regular commit",
        author: { name: "User", email: "user@example.com", username: "user" },
      },
      ...payload,
    },
    octokit: { request: vi.fn() } as never,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  getBotIdentityMock.mockReturnValue({
    login: "my-app[bot]",
    email: "999+my-app[bot]@users.noreply.github.com",
  });
  loadConfigMock.mockResolvedValue({ config, errors: [] });
  sourceShaDedupSeenMock.mockReturnValue(false);
});

describe("handlePushEvent (D-02 filters + D-17 loop prevention + D-18 dedup)", () => {
  it("tag push (ref=refs/tags/v1) → not enqueued", async () => {
    const q = makeQueue();
    await handlePushEvent(makeCtx({ ref: "refs/tags/v1" }), { queue: q });
    expect(q.calls).toHaveLength(0);
    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("created=true → not enqueued", async () => {
    const q = makeQueue();
    await handlePushEvent(makeCtx({ created: true }), { queue: q });
    expect(q.calls).toHaveLength(0);
  });

  it("deleted=true → not enqueued", async () => {
    const q = makeQueue();
    await handlePushEvent(makeCtx({ deleted: true }), { queue: q });
    expect(q.calls).toHaveLength(0);
  });

  it("head_commit=null → not enqueued", async () => {
    const q = makeQueue();
    await handlePushEvent(makeCtx({ head_commit: null }), { queue: q });
    expect(q.calls).toHaveLength(0);
  });

  it("installation missing → not enqueued", async () => {
    const q = makeQueue();
    await handlePushEvent(makeCtx({ installation: null }), { queue: q });
    expect(q.calls).toHaveLength(0);
  });

  it("config invalid (errors[]) → not enqueued + warn log", async () => {
    const q = makeQueue();
    loadConfigMock.mockResolvedValueOnce({
      errors: [{ line: 1, col: 1, message: "bad" }],
    });
    const warnSpy = vi.spyOn(log, "warn");
    await handlePushEvent(makeCtx({}), { queue: q });
    expect(q.calls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("branch is dev_branch → not enqueued (silent, no log)", async () => {
    const q = makeQueue();
    await handlePushEvent(makeCtx({ ref: "refs/heads/dev" }), { queue: q });
    expect(q.calls).toHaveLength(0);
  });

  it("loop prevention: sender=bot → not enqueued + log with reasons", async () => {
    const q = makeQueue();
    const infoSpy = vi.spyOn(log, "info");
    await handlePushEvent(makeCtx({ sender: { login: "my-app[bot]" } }), { queue: q });
    expect(q.calls).toHaveLength(0);
    const events = infoSpy.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(events).toContain("cascade_skipped_loop_prevention");
  });

  it("dedup hit (sourceShaDedup.seen=true) → not enqueued + dedup log", async () => {
    const q = makeQueue();
    sourceShaDedupSeenMock.mockReturnValueOnce(true);
    const infoSpy = vi.spyOn(log, "info");
    await handlePushEvent(makeCtx({}), { queue: q });
    expect(q.calls).toHaveLength(0);
    const events = infoSpy.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(events).toContain("cascade_skipped_dedup");
  });

  it("happy path: push to main → enqueued with full PushJob payload + mark dedup", async () => {
    const q = makeQueue();
    await handlePushEvent(makeCtx({}, "deliv-happy"), { queue: q });
    expect(q.calls).toHaveLength(1);
    const entry = q.calls[0]!;
    expect(entry.id).toBe("deliv-happy");
    expect(entry.payload).toMatchObject({
      installation_id: 42,
      owner: "acme",
      repo: "widgets",
      branch: "main",
      after: "after4567",
      before: "before123",
      sender_login: "user",
      head_commit: {
        id: "after4567",
        message: "regular commit",
        author: { email: "user@example.com", username: "user" },
      },
    });
    expect(entry.payload.config.main_branch).toBe("main");
    expect(sourceShaDedupMarkMock).toHaveBeenCalledWith("acme/widgets@after4567");
  });

  it("happy path: push to release_branch → enqueued with branch=release", async () => {
    const q = makeQueue();
    await handlePushEvent(makeCtx({ ref: "refs/heads/release" }, "deliv-release"), { queue: q });
    expect(q.calls).toHaveLength(1);
    expect(q.calls[0]!.payload.branch).toBe("release");
  });
});
