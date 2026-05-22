import { createHmac, generateKeyPairSync } from "node:crypto";
import { Octokit } from "@octokit/core";
import type { FastifyInstance } from "fastify";
import type { Probot } from "probot";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProbot, initBotIdentity } from "../../src/auth.js";
import type { CascadeJob } from "../../src/cascade/orchestrator.js";
import { runCascade } from "../../src/cascade/orchestrator.js";
import type { Env } from "../../src/env.js";
import { log } from "../../src/log.js";
import { NoopChannel } from "../../src/notify/channel.js";
import { buildServer } from "../../src/server.js";
import { dedup } from "../../src/webhook/dedup.js";
import { createMultiQueue, type MultiQueue } from "../../src/webhook/multiQueue.js";
import { setupMswGitHub } from "../helpers/msw-github.js";

const WEBHOOK_SECRET = "test-webhook-secret-dispatch-32ch";

const harness = setupMswGitHub({
  branches: { main: "main-head-dispatch", release: "release-head", dev: "dev-head" },
  appSlug: "auto-merge-test",
  botUserId: 99999,
});

let probot: Probot;
let app: FastifyInstance;
let queue: MultiQueue<CascadeJob>;
let processedJobs: CascadeJob[];

function signBody(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

function makeDispatchPayload(opts: {
  action?: string;
  sender_login?: string;
  client_payload?: Record<string, unknown> | null;
}): string {
  return JSON.stringify({
    action: opts.action ?? "auto-merge",
    branch: "main",
    client_payload: opts.client_payload ?? null,
    sender: { login: opts.sender_login ?? "user1", type: "User" },
    installation: { id: 42 },
    repository: { name: "widgets", owner: { login: "acme" }, full_name: "acme/widgets" },
  });
}

async function postDispatchWebhook(body: string, deliveryId: string) {
  return app.inject({
    method: "POST",
    url: "/webhook",
    headers: {
      "x-github-delivery": deliveryId,
      "x-github-event": "repository_dispatch",
      "x-hub-signature-256": signBody(body),
      "content-type": "application/json",
    },
    body,
  });
}

beforeAll(async () => {
  harness.server.listen({ onUnhandledRequest: "error" });

  const kp = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const env: Env = {
    APP_ID: 12345,
    WEBHOOK_SECRET,
    PORT: 3011,
    LOG_LEVEL: "error",
    WEBHOOK_QUEUE_MAX: 100,
    SHUTDOWN_TIMEOUT: 5000,
    WEBHOOK_QUEUE_PER_KEY_MAX: 16,
    CRON_SCHEDULE: "*/10 * * * *",
    CRON_TZ: "UTC",
    NOTIFY_DEDUP_TTL_MS: 3_600_000,
    NOTIFY_DEDUP_MAX: 1000,
    NOTIFY_TIMEOUT_MS: 5000,
    NOTIFY_RETRY_ATTEMPTS: 3,
    NODE_ENV: "test",
    PRIVATE_KEY: kp.privateKey,
  };

  probot = createProbot(env);
  await probot.ready();
  await initBotIdentity(env, () => new Octokit({ baseUrl: "https://api.github.com" }));

  processedJobs = [];
  queue = createMultiQueue<CascadeJob>({
    perKeyMax: 16,
    globalMax: 100,
    handler: async (job) => {
      processedJobs.push(job.payload);
      await runCascade(job);
    },
    notify: new NoopChannel(),
  });

  app = await buildServer({ env, log, probot, dedup, queue, notify: new NoopChannel() });
});

afterAll(async () => {
  await app?.close();
  harness.server.close();
});

beforeEach(() => {
  processedJobs.length = 0;
  harness.resetCounters();
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});

describe("repository_dispatch webhook → cascade integration (TRIG-03)", () => {
  it("action=auto-merge → 202 + cascade runs (main HEAD resolved + merge attempted)", async () => {
    harness.state.mergeStatus = 201;
    harness.state.compare = {
      ahead_by: 1,
      total_commits: 1,
      commits: [{ sha: "c1c1c1c", commit: { message: "feat: a" } }],
      base_commit: { sha: "release-head" },
    };

    const body = makeDispatchPayload({ action: "auto-merge", client_payload: { note: "manual" } });
    const resp = await postDispatchWebhook(body, "dlv-dispatch-1");
    expect(resp.statusCode).toBe(202);

    await queue.drain(5000);
    expect(processedJobs).toHaveLength(1);
    expect(processedJobs[0]!.source).toBe("dispatch");
    expect(processedJobs[0]!.after).toBeNull();
    expect(harness.branchCalls.length).toBeGreaterThanOrEqual(1);
    expect(harness.mergeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("action=other → 202 but NO cascade (dispatch handler silently skips unknown actions)", async () => {
    const body = makeDispatchPayload({ action: "other-action" });
    const resp = await postDispatchWebhook(body, "dlv-dispatch-2");
    expect(resp.statusCode).toBe(202);

    await queue.drain(500);
    expect(processedJobs).toHaveLength(0);
    expect(harness.mergeCalls).toHaveLength(0);
  });

  it("bot sender → cascade still runs (loop-prevention exempt per D-10)", async () => {
    // Use a distinct main-branch SHA so sourceShaDedup doesn't suppress this run after the first test.
    harness.setBranchHead("main", "main-head-dispatch-bot");
    harness.state.mergeStatus = 201;
    harness.state.compare = {
      ahead_by: 1,
      total_commits: 1,
      commits: [{ sha: "c2c2c2c", commit: { message: "feat: b" } }],
      base_commit: { sha: "release-head" },
    };

    // Push handler would block on bot sender; dispatch must not (D-10 exemption).
    const body = makeDispatchPayload({ sender_login: "auto-merge-test[bot]" });
    const resp = await postDispatchWebhook(body, "dlv-dispatch-bot-sender");
    expect(resp.statusCode).toBe(202);

    await queue.drain(5000);
    expect(processedJobs).toHaveLength(1);
    expect(processedJobs[0]!.source).toBe("dispatch");
    expect(harness.mergeCalls.length).toBeGreaterThanOrEqual(1);
  });
});
