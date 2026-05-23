import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import { initLogger } from "../../src/log.js";
import { buildServer } from "../../src/server.js";

// Minimal env subset needed by buildServer (only fields it actually uses)
const fakeEnv: Env = {
  APP_ID: 1,
  WEBHOOK_SECRET: "test-secret-1234567890",
  PORT: 3001,
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
};

const noopLog = initLogger({ LOG_LEVEL: "error", NODE_ENV: "test" });

describe("GET /healthz", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer({ env: fakeEnv, log: noopLog });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 200 with { status: 'ok' } regardless of auth state", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("returns 200 even when no readyzFn is provided", async () => {
    // healthz is always alive (D-11) — independent of readiness
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
  });
});
