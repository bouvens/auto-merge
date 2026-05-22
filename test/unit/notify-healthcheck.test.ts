import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createNotifyHealthChecker,
  probeSlack,
  probeTelegram,
} from "../../src/notify/healthCheck.js";
import { createHealthCheckHarness } from "../helpers/msw-healthcheck.js";

const SLACK_URL = "https://hooks.slack.com/services/T00/B00/XYZ";
const TG_TOKEN = "x".repeat(45);
const TG_BODY_OK = { ok: true, result: { id: 1, is_bot: true } };
const TG_BODY_401 = { ok: false, error_code: 401, description: "Unauthorized" };
const TG_BODY_500 = { ok: false, error_code: 500, description: "Internal" };

const harness = createHealthCheckHarness();

beforeAll(() => harness.server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  harness.server.resetHandlers();
  harness.reset();
});
afterAll(() => harness.server.close());

describe("probeSlack", () => {
  it("200 -> ok", async () => {
    harness.setSlack(200);
    expect(await probeSlack(SLACK_URL, 3000)).toBe("ok");
  });

  it("400 -> ok (D-01: any HTTP response = reachable)", async () => {
    harness.setSlack(400);
    expect(await probeSlack(SLACK_URL, 3000)).toBe("ok");
  });

  it("405 -> ok", async () => {
    harness.setSlack(405);
    expect(await probeSlack(SLACK_URL, 3000)).toBe("ok");
  });

  it("503 -> unreachable", async () => {
    harness.setSlack(503);
    expect(await probeSlack(SLACK_URL, 3000)).toBe("unreachable");
  });

  it("timeout -> unreachable", async () => {
    harness.setSlack(200, 200);
    expect(await probeSlack(SLACK_URL, 50)).toBe("unreachable");
  });
});

describe("probeTelegram", () => {
  it("200 -> ok", async () => {
    harness.setTelegram(200, TG_BODY_OK);
    expect(await probeTelegram(TG_TOKEN, 3000)).toBe("ok");
  });

  it("401 -> misconfigured", async () => {
    harness.setTelegram(401, TG_BODY_401);
    expect(await probeTelegram(TG_TOKEN, 3000)).toBe("misconfigured");
  });

  it("500 -> unreachable", async () => {
    harness.setTelegram(500, TG_BODY_500);
    expect(await probeTelegram(TG_TOKEN, 3000)).toBe("unreachable");
  });

  it("timeout -> unreachable", async () => {
    harness.setTelegram(200, TG_BODY_OK, 200);
    expect(await probeTelegram(TG_TOKEN, 50)).toBe("unreachable");
  });
});

describe("createNotifyHealthChecker", () => {
  it("n/a when channel not configured", () => {
    const checker = createNotifyHealthChecker({
      NOTIFY_HEALTHCHECK_TTL_MS: 900_000,
    });
    expect(checker.getStatus()).toEqual({ slack: "n/a", telegram: "n/a" });
    expect(harness.slackCalls()).toBe(0);
    expect(harness.telegramCalls()).toBe(0);
  });

  it("pending before first refresh for configured channels", () => {
    const checker = createNotifyHealthChecker({
      SLACK_WEBHOOK_URL: SLACK_URL,
      TELEGRAM_BOT_TOKEN: TG_TOKEN,
      NOTIFY_HEALTHCHECK_TTL_MS: 900_000,
    });
    const status = checker.getStatus();
    expect(status.slack).toBe("pending");
    expect(status.telegram).toBe("pending");
  });

  it("cache hits within TTL do not re-probe (100 getStatus -> 1 fetch per channel)", async () => {
    const checker = createNotifyHealthChecker({
      SLACK_WEBHOOK_URL: SLACK_URL,
      TELEGRAM_BOT_TOKEN: TG_TOKEN,
      NOTIFY_HEALTHCHECK_TTL_MS: 900_000,
    });
    await checker.refresh();
    expect(checker.getStatus()).toEqual({ slack: "ok", telegram: "ok" });
    for (let i = 0; i < 100; i++) checker.getStatus();
    expect(harness.slackCalls()).toBe(1);
    expect(harness.telegramCalls()).toBe(1);
  });

  it("single-flight: concurrent refresh coalesces into 1 upstream fetch per channel", async () => {
    const checker = createNotifyHealthChecker({
      SLACK_WEBHOOK_URL: SLACK_URL,
      TELEGRAM_BOT_TOKEN: TG_TOKEN,
      NOTIFY_HEALTHCHECK_TTL_MS: 900_000,
    });
    await Promise.all([checker.refresh(), checker.refresh(), checker.refresh()]);
    expect(harness.slackCalls()).toBe(1);
    expect(harness.telegramCalls()).toBe(1);
  });

  it("expired cache triggers lazy refresh on getStatus", async () => {
    const checker = createNotifyHealthChecker({
      SLACK_WEBHOOK_URL: SLACK_URL,
      TELEGRAM_BOT_TOKEN: TG_TOKEN,
      NOTIFY_HEALTHCHECK_TTL_MS: 20,
    });
    await checker.refresh();
    expect(harness.slackCalls()).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    checker.getStatus();
    await checker.refresh();
    expect(harness.slackCalls()).toBe(2);
    expect(harness.telegramCalls()).toBe(2);
  });
});
