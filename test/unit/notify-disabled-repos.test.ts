import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config/schema.js";
import type { NotifyEvent } from "../../src/notify/channel.js";

const DISABLED_REPOS_TTL_MS = 24 * 60 * 60 * 1000;
const DISABLED_REPOS_MAX = 1024;

const envStub = {
  NOTIFY_DEDUP_TTL_MS: 3_600_000,
  NOTIFY_HEALTHCHECK_REQUIRED: false,
  NOTIFY_HEALTHCHECK_TTL_MS: 900_000,
  SETUP_ENABLED: false,
  NOTIFY_DEDUP_MAX: 1000,
  NOTIFY_TIMEOUT_MS: 5000,
  NOTIFY_RETRY_ATTEMPTS: 3,
} as const;

function makeEvent(repo: string): NotifyEvent {
  return {
    kind: "cascade_conflict",
    run_id: `run-${repo}-${Math.random().toString(36).slice(2)}`,
    repo,
    src: "main",
    tgt: "release",
    pr_url: `https://github.com/${repo}/pull/1`,
  };
}

const getConfigWithoutTransport = (_repo: string): Config | undefined => {
  return { branches: { main: "main" }, notifications: {} } as unknown as Config;
};

describe("SlackChannel.disabledRepos — LRU<string,true> with 24h TTL (D-03)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "setInterval"] });
    const { log } = await import("../../src/log.js");
    infoSpy = vi.spyOn(log, "info");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function buildSlack() {
    const { SlackChannel } = await import("../../src/notify/slack.js");
    return new SlackChannel({
      webhookUrl: "https://hooks.slack.test/x",
      env: envStub,
      getConfig: getConfigWithoutTransport,
    });
  }

  function disabledLogCalls(repo: string) {
    return (infoSpy.mock.calls as unknown as unknown[][]).filter((args) => {
      const o = args[0] as { event?: string; repo?: string; channel?: string };
      return (
        o.event === "notifications_disabled_for_repo" && o.repo === repo && o.channel === "slack"
      );
    });
  }

  it("Case 1 — first misconfig for org/a logs exactly once (channel: slack)", async () => {
    const channel = await buildSlack();
    await channel.notify(makeEvent("org/a"));
    expect(disabledLogCalls("org/a")).toHaveLength(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "notifications_disabled_for_repo",
        repo: "org/a",
        channel: "slack",
      }),
      expect.anything(),
    );
  });

  it("Case 2 — second misconfig for the same repo within 24h does not re-log", async () => {
    const channel = await buildSlack();
    await channel.notify(makeEvent("org/a"));
    await channel.notify(makeEvent("org/a"));
    expect(disabledLogCalls("org/a")).toHaveLength(1);
  });

  it("Case 3 — TTL boundary at DISABLED_REPOS_TTL_MS - 1: still suppressed", async () => {
    const channel = await buildSlack();
    await channel.notify(makeEvent("org/a"));
    vi.advanceTimersByTime(DISABLED_REPOS_TTL_MS - 1);
    await channel.notify(makeEvent("org/a"));
    expect(disabledLogCalls("org/a")).toHaveLength(1);
  });

  it("Case 4 — TTL boundary at DISABLED_REPOS_TTL_MS + 1: re-logs (observability restored)", async () => {
    const channel = await buildSlack();
    await channel.notify(makeEvent("org/a"));
    vi.advanceTimersByTime(DISABLED_REPOS_TTL_MS + 1);
    await channel.notify(makeEvent("org/a"));
    expect(disabledLogCalls("org/a")).toHaveLength(2);
  });

  it("Case 5 — LRU eviction: filling 1025 repos evicts org/r0 → re-logs", async () => {
    const channel = await buildSlack();
    for (let i = 0; i <= DISABLED_REPOS_MAX; i++) {
      await channel.notify(makeEvent(`org/r${i}`));
    }
    expect(disabledLogCalls("org/r0")).toHaveLength(1);
    await channel.notify(makeEvent("org/r0"));
    expect(disabledLogCalls("org/r0")).toHaveLength(2);
  });
});

describe("TelegramChannel.disabledRepos — LRU<string,true> with 24h TTL (D-03)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "setInterval"] });
    const { log } = await import("../../src/log.js");
    infoSpy = vi.spyOn(log, "info");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function buildTelegram() {
    const { TelegramChannel } = await import("../../src/notify/telegram.js");
    return new TelegramChannel({
      botToken: "test-token",
      env: envStub,
      getConfig: getConfigWithoutTransport,
    });
  }

  function disabledLogCalls(repo: string) {
    return (infoSpy.mock.calls as unknown as unknown[][]).filter((args) => {
      const o = args[0] as { event?: string; repo?: string; channel?: string };
      return (
        o.event === "notifications_disabled_for_repo" && o.repo === repo && o.channel === "telegram"
      );
    });
  }

  it("Case 1 — first misconfig for org/a logs exactly once (channel: telegram)", async () => {
    const channel = await buildTelegram();
    await channel.notify(makeEvent("org/a"));
    expect(disabledLogCalls("org/a")).toHaveLength(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "notifications_disabled_for_repo",
        repo: "org/a",
        channel: "telegram",
      }),
      expect.anything(),
    );
  });

  it("Case 2 — second misconfig for the same repo within 24h does not re-log", async () => {
    const channel = await buildTelegram();
    await channel.notify(makeEvent("org/a"));
    await channel.notify(makeEvent("org/a"));
    expect(disabledLogCalls("org/a")).toHaveLength(1);
  });

  it("Case 3 — TTL boundary at DISABLED_REPOS_TTL_MS - 1: still suppressed", async () => {
    const channel = await buildTelegram();
    await channel.notify(makeEvent("org/a"));
    vi.advanceTimersByTime(DISABLED_REPOS_TTL_MS - 1);
    await channel.notify(makeEvent("org/a"));
    expect(disabledLogCalls("org/a")).toHaveLength(1);
  });

  it("Case 4 — TTL boundary at DISABLED_REPOS_TTL_MS + 1: re-logs (observability restored)", async () => {
    const channel = await buildTelegram();
    await channel.notify(makeEvent("org/a"));
    vi.advanceTimersByTime(DISABLED_REPOS_TTL_MS + 1);
    await channel.notify(makeEvent("org/a"));
    expect(disabledLogCalls("org/a")).toHaveLength(2);
  });

  it("Case 5 — LRU eviction: filling 1025 repos evicts org/r0 → re-logs", async () => {
    const channel = await buildTelegram();
    for (let i = 0; i <= DISABLED_REPOS_MAX; i++) {
      await channel.notify(makeEvent(`org/r${i}`));
    }
    expect(disabledLogCalls("org/r0")).toHaveLength(1);
    await channel.notify(makeEvent("org/r0"));
    expect(disabledLogCalls("org/r0")).toHaveLength(2);
  });
});
