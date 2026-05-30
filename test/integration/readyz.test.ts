import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { FullEnv } from "../../src/env.js";
import { initLogger } from "../../src/log.js";
import { buildServer } from "../../src/server.js";
import { diagnoseDepsStub } from "../helpers/diagnose-deps.js";

const fakeEnv: FullEnv = {
  _setupOnly: false,
  APP_ID: 1,
  WEBHOOK_SECRET: "test-secret-1234567890",
  PORT: 3002,
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

describe("GET /readyz", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("returns 503 with reason 'readyz-not-wired' when no readyzFn provided", async () => {
    // Default fallback — readyz is intentionally degraded until server wires a real check (Plan 05)
    app = await buildServer({ env: fakeEnv, log: noopLog, ...diagnoseDepsStub });

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not-ready", reason: "readyz-not-wired" });
  });

  it("returns 200 when readyzFn resolves { ok: true }", async () => {
    const readyzFn = async () => ({ ok: true as const });
    app = await buildServer({ env: fakeEnv, log: noopLog, readyzFn, ...diagnoseDepsStub });

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("returns 503 with forwarded reason when readyzFn resolves { ok: false }", async () => {
    const readyzFn = async () => ({ ok: false as const, reason: "jwt-expired" });
    app = await buildServer({ env: fakeEnv, log: noopLog, readyzFn, ...diagnoseDepsStub });

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not-ready", reason: "jwt-expired" });
  });

  it("returns 503 when readyzFn resolves { ok: false } without reason", async () => {
    const readyzFn = async () => ({ ok: false as const });
    app = await buildServer({ env: fakeEnv, log: noopLog, readyzFn, ...diagnoseDepsStub });

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "not-ready" });
  });

  it("merges body keys into 200 response when readyzFn returns body", async () => {
    const readyzFn = async () => ({
      ok: true as const,
      body: { notify_status: { slack: "ok", telegram: "n/a" } },
    });
    app = await buildServer({ env: fakeEnv, log: noopLog, readyzFn, ...diagnoseDepsStub });

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      notify_status: { slack: "ok", telegram: "n/a" },
    });
  });

  it("merges body keys into 503 response when readyzFn returns body", async () => {
    const readyzFn = async () => ({
      ok: false as const,
      reason: "notify-unreachable",
      body: { notify_status: { slack: "unreachable", telegram: "ok" } },
    });
    app = await buildServer({ env: fakeEnv, log: noopLog, readyzFn, ...diagnoseDepsStub });

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not-ready",
      reason: "notify-unreachable",
      notify_status: { slack: "unreachable", telegram: "ok" },
    });
  });

  it("200 response without body — exact shape, no extra keys (backward compat)", async () => {
    const readyzFn = async () => ({ ok: true as const });
    app = await buildServer({ env: fakeEnv, log: noopLog, readyzFn, ...diagnoseDepsStub });

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("503 response without body — exact shape, no extra keys (backward compat)", async () => {
    const readyzFn = async () => ({ ok: false as const, reason: "jwt-expired" });
    app = await buildServer({ env: fakeEnv, log: noopLog, readyzFn, ...diagnoseDepsStub });

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not-ready", reason: "jwt-expired" });
  });

  it("POST /webhook returns 404 (route not registered until Plan 05)", async () => {
    app = await buildServer({ env: fakeEnv, log: noopLog, ...diagnoseDepsStub });

    const response = await app.inject({ method: "POST", url: "/webhook", body: "{}" });

    expect(response.statusCode).toBe(404);
  });
});
