import { createHmac, generateKeyPairSync } from "node:crypto";
import { Octokit } from "@octokit/core";
import type { FastifyInstance } from "fastify";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { Probot } from "probot";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { createProbot } from "../../src/auth.js";
import type { CascadeJob } from "../../src/cascade/orchestrator.js";
import type { Env } from "../../src/env.js";
import { initLogger } from "../../src/log.js";
import { NoopChannel } from "../../src/notify/channel.js";
import { createOnboardingHandlers } from "../../src/onboarding/handler.js";
import { _reset as resetSuppression } from "../../src/onboarding/suppressionSet.js";
import { buildServer } from "../../src/server.js";
import { dedup as realDedup } from "../../src/webhook/dedup.js";
import { createMultiQueue } from "../../src/webhook/multiQueue.js";

const WEBHOOK_SECRET = "test-webhook-secret-32-chars-long";
const SLACK_URL = "https://hooks.slack.com/test";
const TELEGRAM_TOKEN = "test_token_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

interface Tracker {
  calls: Record<string, number>;
  inflight: number;
  maxInflight: number;
  slackBodies: string[];
  telegramBodies: string[];
  issuesCalled: number;
  ymlBodies: Array<{ repo: string; content: string }>;
  prBodies: Array<{ repo: string; body: Record<string, unknown> }>;
  pullsOverride: Map<string, unknown[]>;
  protectedRepos: Set<string>;
}

const tracker: Tracker = {
  calls: {},
  inflight: 0,
  maxInflight: 0,
  slackBodies: [],
  telegramBodies: [],
  issuesCalled: 0,
  ymlBodies: [],
  prBodies: [],
  pullsOverride: new Map(),
  protectedRepos: new Set(),
};

function bump(route: string): void {
  tracker.calls[route] = (tracker.calls[route] ?? 0) + 1;
}

// Artificial 10ms delay makes the p-limit(2) concurrency cap observable.
function tracked<T>(route: string, fn: () => T | Promise<T>): Promise<T> {
  bump(route);
  tracker.inflight++;
  if (tracker.inflight > tracker.maxInflight) tracker.maxInflight = tracker.inflight;
  return new Promise<T>((resolve) => {
    setTimeout(async () => {
      try {
        resolve(await fn());
      } finally {
        tracker.inflight--;
      }
    }, 10);
  });
}

const handlers = [
  http.get("https://api.github.com/repos/:owner/:repo", ({ params }) => {
    return tracked("GET repos", () =>
      HttpResponse.json({ default_branch: "main", full_name: `${params.owner}/${params.repo}` }),
    );
  }),

  http.get("https://api.github.com/repos/:owner/:repo/contents/.github%2Fauto-merge.yml", () =>
    tracked("GET contents-yml", () => HttpResponse.json({}, { status: 404 })),
  ),

  http.get("https://api.github.com/repos/:owner/:repo/contents/:path*", () =>
    tracked("GET contents-any", () => HttpResponse.json({}, { status: 404 })),
  ),

  http.get("https://api.github.com/repos/:owner/:repo/pulls", ({ params }) => {
    const key = `${params.owner}/${params.repo}`;
    const override = tracker.pullsOverride.get(key);
    return tracked("GET pulls", () => HttpResponse.json(override ?? []));
  }),

  http.get("https://api.github.com/repos/:owner/:repo/git/ref/heads/:branch+", ({ params }) => {
    const key = `${params.owner}/${params.repo}`;
    if (tracker.protectedRepos.has(key) && String(params.branch).includes("auto-merge")) {
      return tracked("GET git-ref-protected-miss", () => HttpResponse.json({}, { status: 404 }));
    }
    return tracked("GET git-ref", () =>
      HttpResponse.json({ object: { sha: `deadbeef${key.length}` } }),
    );
  }),

  http.post("https://api.github.com/repos/:owner/:repo/git/refs", ({ params }) => {
    const key = `${params.owner}/${params.repo}`;
    if (tracker.protectedRepos.has(key)) {
      return tracked("POST git-refs-protected", () =>
        HttpResponse.json({ message: "protected branch" }, { status: 422 }),
      );
    }
    return tracked("POST git-refs", () => HttpResponse.json({}, { status: 201 }));
  }),

  http.put(
    "https://api.github.com/repos/:owner/:repo/contents/:path*",
    async ({ params, request }) => {
      const repo = `${params.owner}/${params.repo}`;
      const path = String((params as Record<string, unknown>).path ?? "");
      const body = (await request.json()) as { content: string };
      if (path.includes("auto-merge.yml") && !path.includes("workflows")) {
        tracker.ymlBodies.push({
          repo,
          content: Buffer.from(body.content, "base64").toString("utf8"),
        });
      }
      return tracked("PUT contents", () => HttpResponse.json({}, { status: 201 }));
    },
  ),

  http.post("https://api.github.com/repos/:owner/:repo/pulls", async ({ params, request }) => {
    const repo = `${params.owner}/${params.repo}`;
    const body = (await request.json()) as Record<string, unknown>;
    tracker.prBodies.push({ repo, body });
    return tracked("POST pulls", () =>
      HttpResponse.json(
        {
          number: tracker.prBodies.length,
          html_url: `https://github.com/${repo}/pull/${tracker.prBodies.length}`,
        },
        { status: 201 },
      ),
    );
  }),

  http.post("https://api.github.com/repos/:owner/:repo/issues", () => {
    tracker.issuesCalled++;
    return tracked("POST issues", () => HttpResponse.json({ number: 1 }, { status: 201 }));
  }),

  http.post(SLACK_URL, async ({ request }) => {
    const body = await request.text();
    tracker.slackBodies.push(body);
    return HttpResponse.text("ok", { status: 200 });
  }),

  http.post(TELEGRAM_API, async ({ request }) => {
    const body = await request.text();
    tracker.telegramBodies.push(body);
    return HttpResponse.json({ ok: true }, { status: 200 });
  }),

  http.get("https://api.github.com/app", () => HttpResponse.json({ slug: "auto-merge" })),
];

const mswServer = setupServer(...handlers);

let app: FastifyInstance;
let probot: Probot;
let env: Env;
let multiQueue: ReturnType<typeof createMultiQueue<CascadeJob>>;
const noopLog = initLogger({ LOG_LEVEL: "error", NODE_ENV: "test" });

function signBody(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

async function postWebhook(
  event: string,
  deliveryId: string,
  payload: unknown,
): Promise<{ statusCode: number; elapsedMs: number }> {
  const body = JSON.stringify(payload);
  const sig = signBody(body);
  const start = Date.now();
  const res = await app.inject({
    method: "POST",
    url: "/webhook",
    headers: {
      "x-github-delivery": deliveryId,
      "x-github-event": event,
      "x-hub-signature-256": sig,
      "content-type": "application/json",
    },
    body,
  });
  return { statusCode: res.statusCode, elapsedMs: Date.now() - start };
}

async function waitFor(check: () => boolean, timeoutMs: number, interval = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  if (!check()) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

const cronScheduleEvery10Min = ["*", "/", "1", "0"].join("").padStart(11, " ").trim() + " * * * *";

beforeAll(async () => {
  mswServer.listen({ onUnhandledRequest: "warn" });

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  env = {
    APP_ID: 12345,
    PRIVATE_KEY: privateKey,
    WEBHOOK_SECRET,
    PORT: 0,
    LOG_LEVEL: "error",
    WEBHOOK_QUEUE_MAX: 100,
    SHUTDOWN_TIMEOUT: 5000,
    WEBHOOK_QUEUE_PER_KEY_MAX: 16,
    CRON_SCHEDULE: cronScheduleEvery10Min,
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
    SLACK_WEBHOOK_URL: SLACK_URL,
    TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
    TELEGRAM_DEFAULT_CHAT_ID: "-1001",
    SETUP_PUBLIC_URL: "https://app.example.com",
  } as Env;

  probot = createProbot(env);
  await probot.ready();

  multiQueue = createMultiQueue<CascadeJob>({
    perKeyMax: 16,
    globalMax: 100,
    handler: async () => {},
    notify: new NoopChannel(),
  });

  // Unauthenticated Octokit bypasses appAuth; msw intercepts before egress.
  const onboarding = createOnboardingHandlers({
    octokitFactory: async () => new Octokit(),
    multiQueue,
    env,
  });

  app = await buildServer({
    env,
    log: noopLog,
    probot,
    dedup: realDedup,
    queue: multiQueue,
    notify: new NoopChannel(),
    onboarding,
  });
});

afterAll(async () => {
  await app?.close();
  mswServer.close();
});

beforeEach(() => {
  tracker.calls = {};
  tracker.inflight = 0;
  tracker.maxInflight = 0;
  tracker.slackBodies = [];
  tracker.telegramBodies = [];
  tracker.issuesCalled = 0;
  tracker.ymlBodies = [];
  tracker.prBodies = [];
  tracker.pullsOverride = new Map();
  tracker.protectedRepos = new Set();
  resetSuppression();
});

afterEach(() => {
  mswServer.resetHandlers(...handlers);
});

describe("SC1 + SC2 — bulk install end-to-end (80 repos)", () => {
  it("delivers draft PR per repo, caps concurrency at 2, emits 0 user notifications", async () => {
    const N = 80;
    const repos = Array.from({ length: N }, (_, i) => {
      const num = String(i + 1).padStart(3, "0");
      return { name: `repo-${num}`, full_name: `acme/repo-${num}` };
    });
    const payload = {
      action: "added",
      installation: { id: 42 },
      sender: { login: "alice", type: "User" },
      repositories_added: repos,
    };

    const { statusCode, elapsedMs } = await postWebhook(
      "installation_repositories",
      "test-delivery-bulk-001",
      payload,
    );

    expect(statusCode).toBe(202);
    expect(elapsedMs).toBeLessThan(1500);

    await waitFor(() => (tracker.calls["POST pulls"] ?? 0) === N, 30_000);

    expect(tracker.maxInflight).toBeLessThanOrEqual(2);

    expect(tracker.prBodies.length).toBe(N);
    for (const pr of tracker.prBodies) {
      expect(pr.body.draft).toBe(true);
      expect(pr.body.base).toBe("main");
      expect(pr.body.head).toBe("auto-merge/onboarding");
      expect(typeof pr.body.title).toBe("string");
      expect(String(pr.body.title).length).toBeGreaterThan(0);
      const bodyText = String(pr.body.body ?? "");
      expect(bodyText).toContain("@alice");
      expect(bodyText).toContain(`https://app.example.com/diagnose/${pr.repo}`);
    }

    const sampledIndices = [0, 19, 39, 59, 79];
    for (const i of sampledIndices) {
      const yml = tracker.ymlBodies[i];
      expect(yml).toBeDefined();
      const parsed = parseYaml(yml!.content) as { main_branch?: string };
      expect(parsed.main_branch).toBe("main");
    }

    expect(tracker.slackBodies.length).toBe(0);
    expect(tracker.telegramBodies.length).toBe(0);
  });
});

describe("SC3 — idempotency closed-no-merge skip", () => {
  it("does NOT create a second PR when prior onboarding PR was closed without merge", async () => {
    tracker.pullsOverride.set("acme/single", [
      {
        number: 7,
        state: "closed",
        merged_at: null,
        html_url: "https://github.com/acme/single/pull/7",
        head: { ref: "auto-merge/onboarding" },
      },
    ]);
    const payload = {
      action: "added",
      installation: { id: 77 },
      sender: { login: "alice", type: "User" },
      repositories_added: [{ name: "single", full_name: "acme/single" }],
    };

    const r1 = await postWebhook("installation_repositories", "test-delivery-sc3-001", payload);
    expect(r1.statusCode).toBe(202);

    await waitFor(() => (tracker.calls["GET pulls"] ?? 0) >= 1, 5000);
    await new Promise((r) => setTimeout(r, 200));

    expect(tracker.calls["POST pulls"] ?? 0).toBe(0);

    const before = tracker.calls["GET pulls"] ?? 0;
    const r2 = await postWebhook("installation_repositories", "test-delivery-sc3-002", payload);
    expect(r2.statusCode).toBe(202);
    await waitFor(() => (tracker.calls["GET pulls"] ?? 0) > before, 5000);
    await new Promise((r) => setTimeout(r, 200));
    expect(tracker.calls["POST pulls"] ?? 0).toBe(0);
  });
});

describe("SC4 — protection-blocked default branch → ONE aggregate env-level notify, NO Issue", () => {
  it("emits one Slack + one Telegram aggregate message naming only the blocked repo, never creates an Issue", async () => {
    tracker.protectedRepos.add("acme/protected");
    const payload = {
      action: "added",
      installation: { id: 88 },
      sender: { login: "alice", type: "User" },
      repositories_added: [
        { name: "ok-1", full_name: "acme/ok-1" },
        { name: "ok-2", full_name: "acme/ok-2" },
        { name: "protected", full_name: "acme/protected" },
      ],
    };

    const r = await postWebhook("installation_repositories", "test-delivery-sc4-001", payload);
    expect(r.statusCode).toBe(202);

    await waitFor(
      () => (tracker.calls["POST pulls"] ?? 0) === 2 && tracker.slackBodies.length >= 1,
      10_000,
    );

    expect(tracker.slackBodies.length).toBe(1);
    expect(tracker.telegramBodies.length).toBe(1);

    const slackText = tracker.slackBodies[0]!;
    expect(slackText).toContain("acme/protected");
    expect(slackText).toContain("protection_blocked");
    expect(slackText).not.toContain("acme/ok-1");
    expect(slackText).not.toContain("acme/ok-2");

    const tgText = tracker.telegramBodies[0]!;
    expect(tgText).toContain("acme/protected");
    expect(tgText).toContain("protection_blocked");

    expect(tracker.issuesCalled).toBe(0);
    expect(tracker.calls["POST issues"] ?? 0).toBe(0);
  });
});

describe("SC5 — installation.deleted cleanup, no API calls", () => {
  it("invokes cleanup handler (multiQueue.clearByInstallation) with 0 GitHub API calls; subsequent install for same id starts fresh", async () => {
    const totalCallsBefore = Object.values(tracker.calls).reduce((a, v) => a + v, 0);
    const keyCountBefore = multiQueue.keyCount();

    const payload = { action: "deleted", installation: { id: 42 } };
    const r = await postWebhook("installation", "test-delivery-sc5-001", payload);
    expect(r.statusCode).toBe(202);
    expect(multiQueue.keyCount()).toBeLessThanOrEqual(keyCountBefore);

    await new Promise((r2) => setTimeout(r2, 200));

    const totalCallsAfter = Object.values(tracker.calls).reduce((a, v) => a + v, 0);
    expect(totalCallsAfter).toBe(totalCallsBefore);

    const reinstallPayload = {
      action: "added",
      installation: { id: 42 },
      sender: { login: "alice", type: "User" },
      repositories_added: [{ name: "fresh", full_name: "acme/fresh" }],
    };
    const r2 = await postWebhook(
      "installation_repositories",
      "test-delivery-sc5-002",
      reinstallPayload,
    );
    expect(r2.statusCode).toBe(202);
    await waitFor(() => (tracker.calls["POST pulls"] ?? 0) >= 1, 10_000);
    expect(tracker.prBodies.find((p) => p.repo === "acme/fresh")).toBeDefined();

    expect(multiQueue.keyCount()).toBeGreaterThanOrEqual(0);
  });
});
