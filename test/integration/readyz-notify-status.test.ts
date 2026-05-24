import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import { initLogger } from "../../src/log.js";
import { createNotifyHealthChecker, type NotifyStatus } from "../../src/notify/healthCheck.js";
import { buildServer } from "../../src/server.js";
import { diagnoseDepsStub } from "../helpers/diagnose-deps.js";
import { createHealthCheckHarness } from "../helpers/msw-healthcheck.js";

const SLACK_URL = "https://hooks.slack.com/services/T/B/X";
const TELEGRAM_TOKEN = "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const noopLog = initLogger({ LOG_LEVEL: "error", NODE_ENV: "test" });

function makeEnv(overrides: Partial<Env>): Env {
  return {
    APP_ID: 1,
    WEBHOOK_SECRET: "test-secret-1234567890",
    PORT: 3010,
    LOG_LEVEL: "error",
    WEBHOOK_QUEUE_MAX: 100,
    SHUTDOWN_TIMEOUT: 5000,
    WEBHOOK_QUEUE_PER_KEY_MAX: 16,
    CRON_SCHEDULE: "*/10 * * * *",
    CRON_TZ: "UTC",
    NOTIFY_DEDUP_TTL_MS: 3_600_000,
    NOTIFY_HEALTHCHECK_REQUIRED: false,
    NOTIFY_HEALTHCHECK_TTL_MS: 900_000,
    SETUP_ENABLED: false,
    SETUP_APP_NAME: "auto-merge",
    SETUP_OUTPUT_DIR: "./data",
    DEFAULT_CONFIG_RELOAD_MS: 60_000,
    NOTIFY_DEDUP_MAX: 1000,
    NOTIFY_TIMEOUT_MS: 5000,
    NOTIFY_RETRY_ATTEMPTS: 3,
    NODE_ENV: "test",
    PRIVATE_KEY: "dummy",
    ...overrides,
  };
}

// Mirrors src/index.ts wiring so test coverage is independent of boot-script structure.
function makeWrappedReadyz(env: Env, checker: ReturnType<typeof createNotifyHealthChecker>) {
  const notifyHealthy = (s: NotifyStatus): boolean => s === "ok" || s === "n/a";
  return async (): Promise<{
    ok: boolean;
    reason?: string;
    body?: Record<string, unknown>;
  }> => {
    const notify = checker.getStatus();
    const strict = env.NOTIFY_HEALTHCHECK_REQUIRED;
    const notifyOk = !strict || (notifyHealthy(notify.slack) && notifyHealthy(notify.telegram));
    return {
      ok: notifyOk,
      reason: !notifyOk ? "notify-unreachable" : undefined,
      body: { notify_status: notify },
    };
  };
}

const harness = createHealthCheckHarness();

describe("/readyz notify_status integration", () => {
  let app: FastifyInstance;

  beforeAll(() => harness.server.listen({ onUnhandledRequest: "error" }));
  afterEach(async () => {
    await app?.close();
    harness.server.resetHandlers();
    harness.reset();
  });
  afterAll(() => harness.server.close());

  it("warn-only: returns 200 with notify_status when Slack unreachable", async () => {
    harness.setSlack(503);
    const env = makeEnv({ SLACK_WEBHOOK_URL: SLACK_URL });
    const checker = createNotifyHealthChecker(env);
    await checker.refresh();
    app = await buildServer({
      env,
      log: noopLog,
      readyzFn: makeWrappedReadyz(env, checker),
      ...diagnoseDepsStub,
    });

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      notify_status: { slack: "unreachable", telegram: "n/a" },
    });
  });

  it("strict mode: returns 503 when Slack unreachable", async () => {
    harness.setSlack(503);
    const env = makeEnv({
      SLACK_WEBHOOK_URL: SLACK_URL,
      NOTIFY_HEALTHCHECK_REQUIRED: true,
    });
    const checker = createNotifyHealthChecker(env);
    await checker.refresh();
    app = await buildServer({
      env,
      log: noopLog,
      readyzFn: makeWrappedReadyz(env, checker),
      ...diagnoseDepsStub,
    });

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("not-ready");
    expect(body.reason).toBe("notify-unreachable");
    expect(body.notify_status.slack).toBe("unreachable");
  });

  it("pending state before refresh — warn-only returns 200", async () => {
    const env = makeEnv({ SLACK_WEBHOOK_URL: SLACK_URL });
    const checker = createNotifyHealthChecker(env);
    app = await buildServer({
      env,
      log: noopLog,
      readyzFn: makeWrappedReadyz(env, checker),
      ...diagnoseDepsStub,
    });

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json().notify_status.slack).toBe("pending");
  });

  it("strict mode + pending → 503", async () => {
    const env = makeEnv({
      SLACK_WEBHOOK_URL: SLACK_URL,
      NOTIFY_HEALTHCHECK_REQUIRED: true,
    });
    const checker = createNotifyHealthChecker(env);
    app = await buildServer({
      env,
      log: noopLog,
      readyzFn: makeWrappedReadyz(env, checker),
      ...diagnoseDepsStub,
    });

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json().reason).toBe("notify-unreachable");
  });

  it("body shape — both channels configured and ok", async () => {
    harness.setSlack(200);
    harness.setTelegram(200, { ok: true, result: { id: 1, is_bot: true } });
    const env = makeEnv({
      SLACK_WEBHOOK_URL: SLACK_URL,
      TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
    });
    const checker = createNotifyHealthChecker(env);
    await checker.refresh();
    app = await buildServer({
      env,
      log: noopLog,
      readyzFn: makeWrappedReadyz(env, checker),
      ...diagnoseDepsStub,
    });

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      notify_status: { slack: "ok", telegram: "ok" },
    });
  });

  it("TTL cache: 100 /readyz hits → 1 upstream fetch per channel", async () => {
    harness.setSlack(200);
    harness.setTelegram(200, { ok: true, result: { id: 1, is_bot: true } });
    const env = makeEnv({
      SLACK_WEBHOOK_URL: SLACK_URL,
      TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
    });
    const checker = createNotifyHealthChecker(env);
    await checker.refresh();
    app = await buildServer({
      env,
      log: noopLog,
      readyzFn: makeWrappedReadyz(env, checker),
      ...diagnoseDepsStub,
    });

    for (let i = 0; i < 100; i++) {
      await app.inject({ method: "GET", url: "/readyz" });
    }

    expect(harness.slackCalls()).toBe(1);
    expect(harness.telegramCalls()).toBe(1);
  });
});
