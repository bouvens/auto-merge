import { generateKeyPairSync } from "node:crypto";
import { Octokit } from "@octokit/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let validPem: string;
beforeAll(() => {
  // RSA-2048 is the minimum size GitHub accepts for App private keys.
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  validPem = privateKey;
});

// Fresh module per-test: auth state is module-level cache and we must isolate state.
afterEach(() => {
  vi.resetModules();
});

function makeEnv() {
  return {
    APP_ID: 12345,
    PRIVATE_KEY: validPem,
    WEBHOOK_SECRET: "test-webhook-secret-32-chars-long",
    PORT: 3000,
    LOG_LEVEL: "info" as const,
    WEBHOOK_QUEUE_MAX: 1000,
    SHUTDOWN_TIMEOUT: 30000,
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
    NODE_ENV: "test" as const,
  };
}

describe("getAppOctokit", () => {
  it("throws when called before createProbot", async () => {
    const { getAppOctokit } = await import("../../src/auth.js");
    expect(() => getAppOctokit()).toThrow(/auth not initialised/);
  });

  it("returns an Octokit instance after createProbot is called", async () => {
    const { createProbot, getAppOctokit } = await import("../../src/auth.js");
    createProbot(makeEnv());
    const octokit = getAppOctokit();
    expect(octokit).toBeInstanceOf(Octokit);
  });

  it("returns a fresh instance per call", async () => {
    const { createProbot, getAppOctokit } = await import("../../src/auth.js");
    createProbot(makeEnv());
    const first = getAppOctokit();
    const second = getAppOctokit();
    expect(first).not.toBe(second);
  });
});
