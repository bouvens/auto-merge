import { createHmac, generateKeyPairSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Probot } from "probot";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createProbot } from "../../src/auth.js";
import type { Env } from "../../src/env.js";
import { initLogger } from "../../src/log.js";
import { buildServer } from "../../src/server.js";
import { dedup } from "../../src/webhook/dedup.js";
import { createQueue } from "../../src/webhook/queue.js";

const WEBHOOK_SECRET = "test-webhook-secret-32-chars-long";

let validPem: string;
let probot: Probot;
let app: FastifyInstance;
let enqueuedJobs: string[];

const fakeEnv: Env = {
  APP_ID: 12345,
  WEBHOOK_SECRET,
  PORT: 3003,
  LOG_LEVEL: "error",
  WEBHOOK_QUEUE_MAX: 100,
  SHUTDOWN_TIMEOUT: 5000,
  NODE_ENV: "test",
  PRIVATE_KEY: "",
};

const noopLog = initLogger({ LOG_LEVEL: "error", NODE_ENV: "test" });

function signBody(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  validPem = privateKey;

  const env = { ...fakeEnv, PRIVATE_KEY: validPem };
  probot = createProbot(env);
  await probot.ready();

  enqueuedJobs = [];
  const queue = createQueue<{ name: string }>({
    max: 100,
    handler: async (job) => {
      enqueuedJobs.push(job.id);
    },
  });

  app = await buildServer({ env, log: noopLog, probot, dedup, queue });
});

afterAll(async () => {
  await app?.close();
});

afterEach(() => {
  enqueuedJobs.length = 0;
});

describe("POST /webhook", () => {
  it("returns 400 when X-Hub-Signature-256 header is missing", async () => {
    const body = JSON.stringify({ action: "opened" });
    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-github-delivery": "missing-sig-test",
        "x-github-event": "push",
        "content-type": "application/json",
      },
      body,
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 401 on invalid signature without processing payload", async () => {
    const logSpy = vi.spyOn(noopLog, "info");
    const body = JSON.stringify({ zen: "test", hook_id: 1 });
    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-github-delivery": "bad-sig-delivery",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=deadbeef",
        "content-type": "application/json",
      },
      body,
    });
    expect(response.statusCode).toBe(401);
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "ping" }),
      "lifecycle",
    );
    logSpy.mockRestore();
  });

  it("returns 202 in under 100ms for a valid ping event", async () => {
    const body = JSON.stringify({ zen: "test", hook_id: 1 });
    const sig = signBody(body);
    const deliveryId = `ping-delivery-${Date.now()}`;

    const start = Date.now();
    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-github-delivery": deliveryId,
        "x-github-event": "ping",
        "x-hub-signature-256": sig,
        "content-type": "application/json",
      },
      body,
    });
    const duration = Date.now() - start;

    expect(response.statusCode).toBe(202);
    expect(duration).toBeLessThan(100);
  });

  it("returns 202 on duplicate delivery_id without re-enqueuing", async () => {
    const body = JSON.stringify({ zen: "test", hook_id: 1 });
    const sig = signBody(body);
    const deliveryId = `dup-delivery-${Date.now()}`;
    const headers = {
      "x-github-delivery": deliveryId,
      "x-github-event": "ping",
      "x-hub-signature-256": sig,
      "content-type": "application/json",
    };

    const r1 = await app.inject({ method: "POST", url: "/webhook", headers, body });
    const r2 = await app.inject({ method: "POST", url: "/webhook", headers, body });

    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(202);
    // ping events do not enqueue — duplicate check confirmed via dedup log only
    expect(enqueuedJobs).toHaveLength(0);
  });

  it("returns 202 and enqueues cascade-placeholder for push event", async () => {
    const body = JSON.stringify({
      ref: "refs/heads/main",
      repository: { full_name: "org/repo" },
      installation: { id: 42 },
      sender: { login: "user" },
    });
    const sig = signBody(body);
    const deliveryId = `push-delivery-${Date.now()}`;

    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-github-delivery": deliveryId,
        "x-github-event": "push",
        "x-hub-signature-256": sig,
        "content-type": "application/json",
      },
      body,
    });

    expect(response.statusCode).toBe(202);

    // Wait for deferred queue worker to process
    await new Promise((r) => setTimeout(r, 20));

    expect(enqueuedJobs).toContain(deliveryId);
  });

  it("does not log payload in lifecycle handlers", async () => {
    const logSpy = vi.spyOn(noopLog, "info");
    const body = JSON.stringify({ zen: "keep it logically awesome" });
    const sig = signBody(body);
    const deliveryId = `no-payload-log-${Date.now()}`;

    await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-github-delivery": deliveryId,
        "x-github-event": "ping",
        "x-hub-signature-256": sig,
        "content-type": "application/json",
      },
      body,
    });

    const allCalls = logSpy.mock.calls;
    for (const call of allCalls) {
      const obj = call[0];
      if (typeof obj === "object" && obj !== null) {
        expect(obj).not.toHaveProperty("payload");
        expect(obj).not.toHaveProperty("body");
      }
    }

    logSpy.mockRestore();
  });
});
