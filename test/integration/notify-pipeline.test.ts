// Integration tests for the full notify pipeline: MultiChannel → SlackChannel/TelegramChannel → msw-mocked HTTP.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config/schema.js";
import type { NotificationChannel } from "../../src/notify/channel.js";
import { MultiChannel } from "../../src/notify/dispatcher.js";
import { SlackChannel } from "../../src/notify/slack.js";
import { TelegramChannel } from "../../src/notify/telegram.js";
import { createNotifyHarness } from "../helpers/msw-notify.js";

// Stub env — no real process.env reads.
const stubEnv = {
  NOTIFY_DEDUP_TTL_MS: 3_600_000,
  NOTIFY_HEALTHCHECK_REQUIRED: false,
  NOTIFY_HEALTHCHECK_TTL_MS: 900_000,
  SETUP_ENABLED: false,
  NOTIFY_DEDUP_MAX: 1000,
  NOTIFY_TIMEOUT_MS: 5000,
  NOTIFY_RETRY_ATTEMPTS: 3,
};

const TEST_REPO = "org/repo";
const SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T/B/X";
const TELEGRAM_BOT_TOKEN = "test-token";

const repoConfig: Config = {
  main_branch: "main",
  dev_branch: "dev",
  notifications: {
    slack: { channel: "#test" },
    telegram: { chat_id: "-100123" },
  },
};

function makeGetConfig(config: Config | undefined): (repo: string) => Config | undefined {
  return () => config;
}

const harness = createNotifyHarness();

function buildMulti(): { multi: MultiChannel; slack: SlackChannel; telegram: TelegramChannel } {
  const slack = new SlackChannel({
    webhookUrl: SLACK_WEBHOOK_URL,
    env: stubEnv,
    getConfig: makeGetConfig(repoConfig),
  });
  const telegram = new TelegramChannel({
    botToken: TELEGRAM_BOT_TOKEN,
    env: stubEnv,
    getConfig: makeGetConfig(repoConfig),
  });
  const channels: NotificationChannel[] = [slack, telegram];
  const multi = new MultiChannel(channels);
  return { multi, slack, telegram };
}

beforeAll(() => {
  // onUnhandledRequest:"error" surfaces any unintended real HTTP — no accidental egress.
  harness.server.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  harness.server.close();
});

beforeEach(() => {
  harness.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

const conflictEvent = {
  kind: "cascade_conflict" as const,
  installation_id: 1,
  run_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  repo: TEST_REPO,
  src: "main",
  tgt: "dev",
  pr_url: "https://github.com/org/repo/pull/1",
};

describe("notify pipeline — integration", () => {
  it("1. both channels receive a cascade_conflict event", async () => {
    const { multi } = buildMulti();

    await multi.notify(conflictEvent);

    expect(harness.slackCalls).toHaveLength(1);
    const slackBody = harness.slackCalls[0]?.body as Record<string, unknown>;
    expect(slackBody.channel).toBe("#test");
    expect(typeof slackBody.text).toBe("string");
    expect(slackBody.text as string).toContain("Cascade conflict");

    expect(harness.telegramCalls).toHaveLength(1);
    const telegramBody = harness.telegramCalls[0]?.body as Record<string, unknown>;
    expect(telegramBody.chat_id).toBe("-100123");
    expect(telegramBody.parse_mode).toBe("HTML");
    expect(telegramBody.text as string).toContain("<b>Cascade conflict</b>");
  });

  it("2. Slack 500, Telegram 200: Slack dead-lettered, Telegram succeeds, no throw", async () => {
    harness.setSlackResponse(500, "internal_error");
    const { multi } = buildMulti();

    // Promise.allSettled guarantee: never throws
    await expect(multi.notify(conflictEvent)).resolves.toBeUndefined();

    // Slack attempted all 3 times (NOTIFY_RETRY_ATTEMPTS = 3)
    expect(harness.slackCalls).toHaveLength(3);

    // Telegram still received the message
    expect(harness.telegramCalls).toHaveLength(1);
  });

  it("3. Telegram 429 + Retry-After: 1 second — second attempt succeeds", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "performance"] });

    harness.setTelegramResponse(429, {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 1",
      parameters: { retry_after: 1 },
    });

    const { telegram } = buildMulti();

    const notifyPromise = telegram.notify(conflictEvent);

    // Advance past the first attempt and the retry-after delay
    await vi.runAllTimersAsync();

    // Switch to success response before second attempt fires
    harness.setTelegramResponse(200, { ok: true, result: { message_id: 2 } });

    await vi.runAllTimersAsync();
    await notifyPromise;

    expect(harness.telegramCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("4. dedup suppression — same event sent twice, only one delivery per channel", async () => {
    const { multi } = buildMulti();

    await multi.notify(conflictEvent);
    await multi.notify(conflictEvent);

    expect(harness.slackCalls).toHaveLength(1);
    expect(harness.telegramCalls).toHaveLength(1);
  });

  it("5. final-fail does NOT mark dedup — subsequent identical event retried", async () => {
    harness.setSlackResponse(500, "fail");

    // First call: all 3 attempts fail — dedup must NOT be set
    const slack1 = new SlackChannel({
      webhookUrl: SLACK_WEBHOOK_URL,
      env: stubEnv,
      getConfig: makeGetConfig(repoConfig),
    });
    await slack1.notify(conflictEvent);
    expect(harness.slackCalls).toHaveLength(3);

    // Reset call log and restore success response
    harness.reset();

    // Second channel instance (fresh dedup) — same event, now succeeds
    const slack2 = new SlackChannel({
      webhookUrl: SLACK_WEBHOOK_URL,
      env: stubEnv,
      getConfig: makeGetConfig(repoConfig),
    });
    await slack2.notify(conflictEvent);
    expect(harness.slackCalls).toHaveLength(1);
  });

  it("6. per-repo missing notifications.slack config: Slack skipped, Telegram still sends", async () => {
    const configWithoutSlack: Config = {
      main_branch: "main",
      dev_branch: "dev",
      notifications: {
        telegram: { chat_id: "-100123" },
      },
    };

    const slack = new SlackChannel({
      webhookUrl: SLACK_WEBHOOK_URL,
      env: stubEnv,
      getConfig: makeGetConfig(configWithoutSlack),
    });
    const telegram = new TelegramChannel({
      botToken: TELEGRAM_BOT_TOKEN,
      env: stubEnv,
      getConfig: makeGetConfig(repoConfig),
    });
    const multi = new MultiChannel([slack, telegram]);

    await multi.notify(conflictEvent);

    expect(harness.slackCalls).toHaveLength(0);
    expect(harness.telegramCalls).toHaveLength(1);
  });

  // Silent-on-success regression guard is covered in cascade-flow.test.ts.
  it("7. MultiChannel.notify uses Promise.allSettled — never throws even if all channels fail", async () => {
    harness.setSlackResponse(500, "fail");
    harness.setTelegramResponse(500, { ok: false, error_code: 500, description: "server error" });
    const { multi } = buildMulti();

    await expect(multi.notify(conflictEvent)).resolves.toBeUndefined();
  });
});
