import { generateKeyPairSync } from "node:crypto";
import { http } from "msw";
import { setupServer } from "msw/node";
import type { Probot } from "probot";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FullEnv } from "../../src/env.js";

// onUnhandledRequest:'error' proves readyzCheck makes zero network calls.
const server = setupServer();

beforeAll(() =>
  server.listen({
    onUnhandledRequest: "error",
  }),
);

afterAll(() => server.close());

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

function makeEnv(overrides: Partial<{ PRIVATE_KEY: string }> = {}): FullEnv {
  return {
    _setupOnly: false,
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
    ...overrides,
  };
}

describe("createProbot", () => {
  it("returns a Probot instance and webhooks is accessible after ready()", async () => {
    const { createProbot } = await import("../../src/auth.js");
    const probot: Probot = createProbot(makeEnv());
    expect(probot).toBeDefined();
    // Probot initialises webhooks asynchronously; ready() resolves once webhooks is set.
    await probot.ready();
    expect(probot.webhooks).toBeDefined();
    expect(typeof probot.webhooks.verifyAndReceive).toBe("function");
  });
});

describe("readyzCheck", () => {
  it("returns {ok:true} and makes no network requests when key is valid", async () => {
    // Catch-all handler throws if any request reaches the network.
    server.use(
      http.all("*", () => {
        throw new Error("readyzCheck must not make network calls");
      }),
    );

    const { createProbot, readyzCheck } = await import("../../src/auth.js");
    createProbot(makeEnv());

    const result = await readyzCheck();
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns {ok:false, reason} when PRIVATE_KEY is not a valid PEM", async () => {
    const { createProbot, readyzCheck } = await import("../../src/auth.js");
    createProbot(makeEnv({ PRIVATE_KEY: "not a pem" }));

    const result = await readyzCheck();
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe("string");
    expect(result.reason?.length).toBeGreaterThan(0);
  });

  it("does not throw even when key is broken — always resolves", async () => {
    const { createProbot, readyzCheck } = await import("../../src/auth.js");
    createProbot(makeEnv({ PRIVATE_KEY: "not a pem" }));

    await expect(readyzCheck()).resolves.toBeDefined();
  });

  it("always returns an object with an ok property", async () => {
    const { readyzCheck } = await import("../../src/auth.js");
    const result = await readyzCheck();
    expect(result).toHaveProperty("ok");
  });
});
