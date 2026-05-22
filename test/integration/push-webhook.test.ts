import { createHmac, generateKeyPairSync } from "node:crypto";
import { Octokit } from "@octokit/core";
import type { FastifyInstance } from "fastify";
import type { Probot } from "probot";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProbot, initBotIdentity } from "../../src/auth.js";
import type { CascadeJob, PushJob } from "../../src/cascade/orchestrator.js";
import { runCascade } from "../../src/cascade/orchestrator.js";
import type { Env } from "../../src/env.js";
import { log } from "../../src/log.js";
import { NoopChannel } from "../../src/notify/channel.js";
import { buildServer } from "../../src/server.js";
import { dedup } from "../../src/webhook/dedup.js";
import { createMultiQueue, type MultiQueue } from "../../src/webhook/multiQueue.js";
import { setupMswGitHub } from "../helpers/msw-github.js";

const WEBHOOK_SECRET = "test-webhook-secret-32-chars-long";

const harness = setupMswGitHub({
  branches: { main: "main-head", release: "release-head", dev: "dev-head" },
  appSlug: "auto-merge-test",
  botUserId: 99999,
});

let privateKey: string;
let probot: Probot;
let app: FastifyInstance;
let queue: MultiQueue<CascadeJob>;
let enqueued: Array<{ id: string; payload: PushJob }>;
let botLogin: string;

function signBody(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

function makePushPayload(opts: {
  ref?: string;
  created?: boolean;
  deleted?: boolean;
  head_commit?: unknown;
  sender_login?: string;
  after?: string;
}): string {
  return JSON.stringify({
    ref: opts.ref ?? "refs/heads/main",
    created: opts.created ?? false,
    deleted: opts.deleted ?? false,
    before: "before-sha",
    after: opts.after ?? `sha-${Math.random().toString(36).slice(2)}`,
    repository: { name: "widgets", owner: { login: "acme" } },
    installation: { id: 42 },
    sender: { login: opts.sender_login ?? "alice" },
    head_commit:
      opts.head_commit === undefined
        ? {
            id: opts.after ?? "head-sha",
            message: "feat: regular",
            author: { name: "Alice", email: "alice@example.com", username: "alice" },
          }
        : opts.head_commit,
  });
}

async function postWebhook(body: string, deliveryId: string) {
  return app.inject({
    method: "POST",
    url: "/webhook",
    headers: {
      "x-github-delivery": deliveryId,
      "x-github-event": "push",
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
  privateKey = kp.privateKey;

  const env: Env = {
    APP_ID: 12345,
    WEBHOOK_SECRET,
    PORT: 3010,
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
    PRIVATE_KEY: privateKey,
  };

  probot = createProbot(env);
  await probot.ready();
  // Plain Octokit factory — auth-app installation auth would fail without installationId on the /users/:slug[bot] call (msw intercepts both endpoints regardless of auth).
  await initBotIdentity(env, () => new Octokit({ baseUrl: "https://api.github.com" }));
  botLogin = `${harness.state.appSlug}[bot]`;

  enqueued = [];
  queue = createMultiQueue<CascadeJob>({
    perKeyMax: 16,
    globalMax: 100,
    handler: async (job) => {
      enqueued.push({ id: job.id, payload: job.payload as PushJob });
      await runCascade(job);
    },
    notify: new NoopChannel(),
  });

  app = await buildServer({ env, log, probot, dedup, queue });
});

afterAll(async () => {
  await app?.close();
  harness.server.close();
});

beforeEach(() => {
  enqueued.length = 0;
  harness.resetCounters();
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});

describe("push → webhook integration (HMAC → probot → push handler → queue)", () => {
  it("D-02 tag push (refs/tags/v1) → 202, no enqueue, no GitHub calls", async () => {
    const body = makePushPayload({ ref: "refs/tags/v1", after: "sha-tag-1" });
    const resp = await postWebhook(body, "dlv-tag-1");
    expect(resp.statusCode).toBe(202);
    await queue.drain(500);
    expect(enqueued).toHaveLength(0);
    expect(harness.mergeCalls).toHaveLength(0);
  });

  it("D-02 created branch (created=true) → 202, no enqueue", async () => {
    const body = makePushPayload({ created: true, after: "sha-created-1" });
    const resp = await postWebhook(body, "dlv-created-1");
    expect(resp.statusCode).toBe(202);
    await queue.drain(500);
    expect(enqueued).toHaveLength(0);
  });

  it("D-02 deleted branch (deleted=true) → 202, no enqueue", async () => {
    const body = makePushPayload({ deleted: true, after: "sha-deleted-1" });
    const resp = await postWebhook(body, "dlv-deleted-1");
    expect(resp.statusCode).toBe(202);
    await queue.drain(500);
    expect(enqueued).toHaveLength(0);
  });

  it("D-02 push to dev_branch (not in cascade source set) → 202, no enqueue", async () => {
    const body = makePushPayload({ ref: "refs/heads/dev", after: "sha-dev-1" });
    const resp = await postWebhook(body, "dlv-dev-1");
    expect(resp.statusCode).toBe(202);
    await queue.drain(500);
    expect(enqueued).toHaveLength(0);
  });

  it("TRIG-01 happy path: push to main → 202, enqueued, msw observes compare + merge", async () => {
    const after = "sha-happy-aaaaaaaaaa";
    harness.state.compare = {
      ahead_by: 1,
      total_commits: 1,
      commits: [{ sha: "c1c1c1c", commit: { message: "feat: a" } }],
      base_commit: { sha: "release-head" },
    };
    harness.state.mergeStatus = 201;

    const body = makePushPayload({ after });
    const resp = await postWebhook(body, "dlv-happy-1");
    expect(resp.statusCode).toBe(202);

    await queue.drain(5000);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.payload.after).toBe(after);
    expect(harness.compareCalls.length).toBeGreaterThanOrEqual(1);
    expect(harness.mergeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("TRIG-04 sourceShaDedup: same after-sha twice → only first enqueues", async () => {
    const after = "sha-dedup-bbbbbbbbbb";
    harness.state.compare = {
      ahead_by: 1,
      total_commits: 1,
      commits: [{ sha: "c1c1c1c", commit: { message: "feat: a" } }],
      base_commit: { sha: "release-head" },
    };
    harness.state.mergeStatus = 201;

    const body = makePushPayload({ after });
    const r1 = await postWebhook(body, "dlv-dedup-1");
    expect(r1.statusCode).toBe(202);
    await queue.drain(5000);
    const firstCount = enqueued.length;

    const r2 = await postWebhook(body, "dlv-dedup-2");
    expect(r2.statusCode).toBe(202);
    await queue.drain(5000);

    expect(firstCount).toBe(1);
    expect(enqueued.length).toBe(1);
  });

  it("CASC-02 loop prevention via sender.login=bot → no enqueue", async () => {
    const body = makePushPayload({ sender_login: botLogin, after: "sha-loop-sender-1" });
    const resp = await postWebhook(body, "dlv-loop-sender");
    expect(resp.statusCode).toBe(202);
    await queue.drain(500);
    expect(enqueued).toHaveLength(0);
  });

  it("CASC-02 loop prevention via Auto-Merge trailer → no enqueue", async () => {
    const after = "sha-loop-trailer-1";
    const body = makePushPayload({
      after,
      head_commit: {
        id: after,
        message: "feat: x\n\nbody line\n\nAuto-Merge: cascade abc",
        author: { name: "Alice", email: "alice@example.com", username: "alice" },
      },
    });
    const resp = await postWebhook(body, "dlv-loop-trailer");
    expect(resp.statusCode).toBe(202);
    await queue.drain(500);
    expect(enqueued).toHaveLength(0);
  });
});
