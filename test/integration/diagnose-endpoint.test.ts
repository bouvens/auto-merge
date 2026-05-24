import { Octokit } from "@octokit/core";
import type { FastifyInstance } from "fastify";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import type { NotifyHealthChecker } from "../../src/notify/healthCheck.js";
import { buildServer } from "../../src/server.js";

// Unauthenticated Octokit: msw intercepts at the HTTP layer and ignores Authorization headers, so the test sidesteps real JWT signing / installation-token flow. The integration test exercises the wired buildServer (server.ts + handler.ts + probes.ts + markdown.ts) against stubbed GitHub endpoints; the auth path itself is covered by handler.test.ts and auth.test.ts.
function makeOctokit(): Octokit {
  return new Octokit();
}

const DIAGNOSE_TOKEN = "diag-token-1234567890abcdef";
const SLACK_SECRET_TOKEN = "SECRET_TOKEN_SEGMENT_XYZ";
const TELEGRAM_SECRET_TOKEN = "AAA_SECRET_BOT_TOKEN_VALUE_AAAAAAAAAA";
const SLACK_URL = `https://hooks.slack.com/services/T1/B1/${SLACK_SECRET_TOKEN}`;
const TELEGRAM_TOKEN = `1234567890:${TELEGRAM_SECRET_TOKEN}`;

const OWNER = "testowner";
const REPO = "testrepo";

const noopLog = pino({ level: "silent" });

function makeEnv(overrides: Partial<Env>): Env {
  return {
    APP_ID: 1,
    PRIVATE_KEY: "dummy",
    WEBHOOK_SECRET: "test-secret-1234567890abc",
    PORT: 0,
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
    DIAGNOSE_TOKEN,
    ...overrides,
  };
}

function fakeHealthChecker(): NotifyHealthChecker {
  return {
    getStatus: () => ({ slack: "ok", telegram: "ok" }),
    refresh: async () => {},
  };
}

const validYaml = "main_branch: main\ndev_branch: dev\n";
const validYamlB64 = Buffer.from(validYaml, "utf8").toString("base64");

function buildHappyMsw() {
  return [
    http.get(`https://api.github.com/repos/${OWNER}/${REPO}/installation`, () =>
      HttpResponse.json({ id: 999, permissions: {}, events: [] }),
    ),

    http.get(`https://api.github.com/repos/${OWNER}/${REPO}`, () =>
      HttpResponse.json({ default_branch: "main" }),
    ),

    http.get("https://api.github.com/app/installations/999", () =>
      HttpResponse.json({
        id: 999,
        permissions: {
          contents: "write",
          pull_requests: "write",
          checks: "write",
          metadata: "read",
        },
        events: [],
      }),
    ),

    http.get(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/.github%2Fauto-merge.yml`,
      () =>
        HttpResponse.json({
          type: "file",
          encoding: "base64",
          content: validYamlB64,
          path: ".github/auto-merge.yml",
        }),
    ),

    http.get(`https://api.github.com/repos/${OWNER}/${REPO}/pulls`, () => HttpResponse.json([])),

    http.get(`https://api.github.com/repos/${OWNER}/${REPO}/branches/main`, () =>
      HttpResponse.json({ name: "main", protected: false }),
    ),
    http.get(`https://api.github.com/repos/${OWNER}/${REPO}/branches/dev`, () =>
      HttpResponse.json({ name: "dev", protected: false }),
    ),

    // 404 on protection endpoint = branch unprotected per D-05.3 — not a probe failure.
    http.get(`https://api.github.com/repos/${OWNER}/${REPO}/branches/main/protection`, () =>
      HttpResponse.json({ message: "Branch not protected" }, { status: 404 }),
    ),
    http.get(`https://api.github.com/repos/${OWNER}/${REPO}/branches/dev/protection`, () =>
      HttpResponse.json({ message: "Branch not protected" }, { status: 404 }),
    ),
  ];
}

const mswServer = setupServer(...buildHappyMsw());

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers(...buildHappyMsw()));
afterAll(() => mswServer.close());

interface BootOpts {
  envOverrides?: Partial<Env>;
}

async function boot(opts: BootOpts = {}): Promise<FastifyInstance> {
  const env = makeEnv(opts.envOverrides ?? {});
  return buildServer({
    env,
    log: noopLog,
    healthChecker: fakeHealthChecker(),
    getAppOctokit: () => makeOctokit(),
    getInstallationOctokit: async () => makeOctokit(),
  });
}

const URL_PATH = `/diagnose/${OWNER}/${REPO}`;
const bearer = `Bearer ${DIAGNOSE_TOKEN}`;

describe("Phase 10 end-to-end — /diagnose endpoint", () => {
  // Fresh app per test so the per-server rate-limit singleton (SC3) starts from zero.
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  describe("SC1 — happy path covers all 6 sections", () => {
    it("returns 200 JSON with the canonical envelope and all check keys", async () => {
      app = await boot();

      const res = await app.inject({
        method: "GET",
        url: URL_PATH,
        headers: { authorization: bearer },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");

      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(
        ["checked_at", "checks", "ok", "owner", "repo"].sort(),
      );
      expect(body.owner).toBe(OWNER);
      expect(body.repo).toBe(REPO);
      expect(typeof body.checked_at).toBe("string");

      expect(Object.keys(body.checks).sort()).toEqual(
        ["app_installed", "app_permissions", "branches", "config", "notify", "onboarding"].sort(),
      );

      expect(body.checks.app_installed.status).toBe("ok");
      expect(body.checks.app_installed.installation_id).toBe(999);
      expect(body.checks.app_permissions.status).toBe("ok");
      expect(body.checks.config.status).toBe("ok");
      expect(body.checks.config.main_branch).toBe("main");
      expect(body.checks.config.dev_branch).toBe("dev");
      // exists but unprotected → branches=warn; warn does not flip ok=false.
      expect(body.checks.branches.status).toBe("warn");
      expect(body.checks.notify.status).toBe("ok");
      expect(body.checks.onboarding.status).toBe("ok");
      expect(body.ok).toBe(true);
    });

    it("returns 200 text/markdown with proper header when Accept: text/markdown", async () => {
      app = await boot();

      const res = await app.inject({
        method: "GET",
        url: URL_PATH,
        headers: { authorization: bearer, accept: "text/markdown" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/markdown/);
      expect(res.body.startsWith(`# Diagnose: ${OWNER}/${REPO}`)).toBe(true);
    });
  });

  describe("SC2 — auth gates", () => {
    it("503 with diagnose-disabled when DIAGNOSE_TOKEN env is unset (even with auth header)", async () => {
      app = await boot({ envOverrides: { DIAGNOSE_TOKEN: undefined } });

      const res = await app.inject({
        method: "GET",
        url: URL_PATH,
        headers: { authorization: bearer },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "diagnose-disabled" });
    });

    it("401 when Authorization header is missing", async () => {
      app = await boot();

      const res = await app.inject({ method: "GET", url: URL_PATH });

      expect(res.statusCode).toBe(401);
    });

    it("401 on equal-length wrong bearer token", async () => {
      app = await boot();
      const wrongEqualLen = "x".repeat(DIAGNOSE_TOKEN.length);

      const res = await app.inject({
        method: "GET",
        url: URL_PATH,
        headers: { authorization: `Bearer ${wrongEqualLen}` },
      });

      expect(res.statusCode).toBe(401);
    });

    it("401 on length-mismatched wrong bearer token (length-mismatch dummy branch safe)", async () => {
      app = await boot();

      const res = await app.inject({
        method: "GET",
        url: URL_PATH,
        headers: { authorization: "Bearer short" },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe("SC3 — rate-limit", () => {
    it("11th burst hit from same client returns 429 with positive Retry-After", async () => {
      app = await boot();

      for (let i = 0; i < 10; i++) {
        const r = await app.inject({
          method: "GET",
          url: URL_PATH,
          headers: { authorization: bearer },
        });
        expect(r.statusCode).toBe(200);
      }

      const eleventh = await app.inject({
        method: "GET",
        url: URL_PATH,
        headers: { authorization: bearer },
      });

      expect(eleventh.statusCode).toBe(429);
      const retryAfter = Number(eleventh.headers["retry-after"]);
      expect(retryAfter).toBeGreaterThan(0);
    });
  });

  describe("SC4 — secret redaction", () => {
    it("planted Slack/Telegram tokens never appear in the JSON response body", async () => {
      app = await boot({
        envOverrides: {
          SLACK_WEBHOOK_URL: SLACK_URL,
          TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: URL_PATH,
        headers: { authorization: bearer },
      });

      expect(res.statusCode).toBe(200);
      // String-contains on the raw body is the most resilient redaction assertion — any future refactor that accidentally inlines a token segment into the response fails fast.
      expect(res.body).not.toContain(SLACK_SECRET_TOKEN);
      expect(res.body).not.toContain("AAA_SECRET_BOT_TOKEN_VALUE");
      expect(res.body).not.toContain(DIAGNOSE_TOKEN);
    });
  });

  describe("regression — app not installed (full key-set invariant on early-exit)", () => {
    it("200 with checks.app_installed.status=error and other sections n/a", async () => {
      app = await boot();
      mswServer.use(
        http.get(`https://api.github.com/repos/${OWNER}/${REPO}/installation`, () =>
          HttpResponse.json({ message: "Not Found" }, { status: 404 }),
        ),
      );

      const res = await app.inject({
        method: "GET",
        url: URL_PATH,
        headers: { authorization: bearer },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      // SC1 invariant: response shape stable even on early-exit.
      expect(Object.keys(body.checks).sort()).toEqual(
        ["app_installed", "app_permissions", "branches", "config", "notify", "onboarding"].sort(),
      );

      expect(body.checks.app_installed.status).toBe("error");
      expect(body.checks.app_installed.detail).toBe("app-not-installed");
      expect(body.checks.app_permissions.status).toBe("n/a");
      expect(body.checks.config.status).toBe("n/a");
      expect(body.checks.branches.status).toBe("n/a");
      expect(body.checks.notify.status).toBe("n/a");
      expect(body.checks.onboarding.status).toBe("n/a");
      expect(body.ok).toBe(false);
    });
  });
});
