import { generateKeyPairSync } from "node:crypto";
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
    NOTIFY_DEDUP_MAX: 1000,
    NOTIFY_TIMEOUT_MS: 5000,
    NOTIFY_RETRY_ATTEMPTS: 3,
    NODE_ENV: "test" as const,
  };
}

// Fresh module per-test: bot identity is module-level cache and we must isolate state.
afterEach(() => {
  vi.resetModules();
});

function fakeOctokitFactory() {
  // Mocked Octokit minimal surface — initBotIdentity only calls .request().
  return {
    request: vi.fn(async (route: string) => {
      if (route === "GET /app") {
        return { data: { slug: "my-app", id: 1234 } };
      }
      if (route.startsWith("GET /users/")) {
        return { data: { id: 41898282, login: "my-app[bot]" } };
      }
      throw new Error(`unexpected route ${route}`);
    }),
    // biome-ignore lint/suspicious/noExplicitAny: test fake doesn't model full Octokit
  } as any;
}

describe("getBotIdentity", () => {
  it("throws when called before initBotIdentity", async () => {
    const { getBotIdentity } = await import("../../src/auth.js");
    expect(() => getBotIdentity()).toThrow(/not initialised/);
  });
});

describe("initBotIdentity", () => {
  it("composes login and lowercase noreply email from bot user_id (NOT app.id)", async () => {
    const { initBotIdentity, getBotIdentity } = await import("../../src/auth.js");
    await initBotIdentity(makeEnv(), fakeOctokitFactory);
    const identity = getBotIdentity();
    expect(identity.login).toBe("my-app[bot]");
    // Critical: bot user_id (41898282), not app.id (1234) — RESEARCH.md Pitfall 1.
    expect(identity.email).toBe("41898282+my-app[bot]@users.noreply.github.com");
    expect(identity.email).toBe(identity.email.toLowerCase());
  });
});

describe("getInstallationOctokit", () => {
  it("throws when appAuth has not been initialised via createProbot", async () => {
    const { getInstallationOctokit } = await import("../../src/auth.js");
    await expect(getInstallationOctokit(99)).rejects.toThrow(/auth not initialised/);
  });
});
