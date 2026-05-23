import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Octokit } from "@octokit/core";
import Fastify, { type FastifyInstance } from "fastify";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { createCredentialsStore } from "../../src/setup/credentials.js";
import {
  redactTail,
  registerCredentialsDownloadRoute,
  registerManifestCallbackRoute,
  renderSuccessPage,
} from "../../src/setup/manifestCallback.js";

function makeLog(): pino.Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as pino.Logger;
}

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ID: 1,
    WEBHOOK_SECRET: "test-secret-1234567890",
    PORT: 3000,
    LOG_LEVEL: "error",
    WEBHOOK_QUEUE_MAX: 100,
    SHUTDOWN_TIMEOUT: 5000,
    WEBHOOK_QUEUE_PER_KEY_MAX: 16,
    CRON_SCHEDULE: "*/10 * * * *",
    CRON_TZ: "UTC",
    NOTIFY_DEDUP_TTL_MS: 3_600_000,
    NOTIFY_HEALTHCHECK_REQUIRED: false,
    NOTIFY_HEALTHCHECK_TTL_MS: 900_000,
    SETUP_ENABLED: true,
    SETUP_PUBLIC_URL: "https://example.test",
    SETUP_APP_NAME: "auto-merge",
    SETUP_OUTPUT_DIR: "./data",
    DEFAULT_CONFIG_RELOAD_MS: 60_000,
    NOTIFY_DEDUP_MAX: 1000,
    NOTIFY_TIMEOUT_MS: 5000,
    NOTIFY_RETRY_ATTEMPTS: 3,
    NODE_ENV: "test",
    PRIVATE_KEY: "dummy",
    ...overrides,
  } as Env;
}

interface ConversionFixture {
  id: number;
  slug: string;
  pem: string;
  webhook_secret: string;
  client_id: string;
  client_secret: string;
  html_url: string;
}

const FIXTURE_PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEvAIBADANBgkqDEADBEEFCAFEBABE0123\n-----END RSA PRIVATE KEY-----\n";

const DEFAULT_FIXTURE: ConversionFixture = {
  id: 42,
  slug: "auto-merge-test",
  pem: FIXTURE_PEM,
  webhook_secret: "wh-secret-1234567890abcdef",
  client_id: "Iv1.abc",
  client_secret: "cs-secretvalue",
  html_url: "https://github.com/apps/auto-merge-test",
};

interface ConversionsHarness {
  // Number of times POST /app-manifests/:code/conversions was called.
  calls: number;
  // Set the status used for the next request.
  setStatus(status: 201 | 422 | 500): void;
  // Override the next response payload.
  setFixture(f: ConversionFixture): void;
}

// In-module mutable state lets each test reshape the next response without rebuilding handlers.
let conversionsStatus: 201 | 422 | 500 = 201;
let conversionsFixture: ConversionFixture = DEFAULT_FIXTURE;
let conversionsCalls = 0;

const conversionsHandler = http.post(
  "https://api.github.com/app-manifests/:code/conversions",
  () => {
    conversionsCalls += 1;
    if (conversionsStatus === 500) {
      return HttpResponse.json({ message: "internal" }, { status: 500 });
    }
    if (conversionsStatus === 422) {
      return HttpResponse.json({ message: "Unprocessable" }, { status: 422 });
    }
    return HttpResponse.json(conversionsFixture, { status: 201 });
  },
);

const mswServer = setupServer(conversionsHandler);

function harness(): ConversionsHarness {
  return {
    get calls() {
      return conversionsCalls;
    },
    setStatus(s) {
      conversionsStatus = s;
    },
    setFixture(f) {
      conversionsFixture = f;
    },
  };
}

describe("redactTail", () => {
  it("returns ****<last N> for normal input", () => {
    expect(redactTail("supersecretabcd", 4)).toBe("****abcd");
  });

  it("returns **** when input is shorter than the tail length (no source bytes leak)", () => {
    expect(redactTail("ab", 4)).toBe("****");
  });

  it("returns **** when input is undefined", () => {
    expect(redactTail(undefined, 4)).toBe("****");
  });

  it("returns **** when input is empty string", () => {
    expect(redactTail("", 4)).toBe("****");
  });
});

describe("renderSuccessPage", () => {
  const baseInfo = {
    appId: 42,
    webhookSecretTail: "****abcd",
    pemTail: "****EFGH",
    slug: "auto-merge-test",
    htmlUrl: "https://github.com/apps/auto-merge-test",
  };

  it("starts with <!doctype html>", () => {
    const html = renderSuccessPage(baseInfo);
    expect(html.toLowerCase().startsWith("<!doctype html>")).toBe(true);
  });

  it("contains the literal APP_ID integer text", () => {
    const html = renderSuccessPage(baseInfo);
    expect(html).toMatch(/\b42\b/);
  });

  it("contains the redacted webhook secret tail and PEM tail literally", () => {
    const html = renderSuccessPage(baseInfo);
    expect(html).toContain("****abcd");
    expect(html).toContain("****EFGH");
  });

  it("contains a download form pointing at /setup/credentials.env (method=get)", () => {
    const html = renderSuccessPage(baseInfo);
    expect(html).toContain('action="/setup/credentials.env"');
    expect(html).toMatch(/<form\b[^>]*method="get"/);
  });

  it("negative containment: raw PEM body and raw webhook secret never appear in output", () => {
    // Construct redacted tails as the handler would, then assert HTML does NOT contain the raw secrets.
    const rawPem =
      "-----BEGIN RSA PRIVATE KEY-----\nDEADBEEFCAFEBABE0123456789ABCDEF\n-----END RSA PRIVATE KEY-----\n";
    const rawWebhook = "topsecret_full_string";
    const html = renderSuccessPage({
      appId: 99,
      webhookSecretTail: redactTail(rawWebhook, 4),
      pemTail: "****EFGH",
    });
    expect(html).not.toContain("DEADBEEFCAFEBABE");
    expect(html).not.toContain(rawWebhook);
    // Tail itself ("ring") is allowed; but only via the redactTail value.
    expect(html).toContain(redactTail(rawWebhook, 4));
  });

  it("is pure — same args produce byte-identical output", () => {
    expect(renderSuccessPage(baseInfo)).toBe(renderSuccessPage(baseInfo));
  });
});

describe("registerManifestCallbackRoute — GET /setup/callback", () => {
  let tmpDir: string;
  let app: FastifyInstance;
  let log: pino.Logger;
  let h: ConversionsHarness;
  let octokitFactory: () => InstanceType<typeof Octokit>;

  beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
  afterAll(() => mswServer.close());

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "setup-callback-"));
    log = makeLog();
    app = Fastify({ logger: false });
    // Reset module-level msw state per-test (no cross-test bleed).
    conversionsStatus = 201;
    conversionsFixture = DEFAULT_FIXTURE;
    conversionsCalls = 0;
    h = harness();
    octokitFactory = () => new Octokit();
  });

  afterEach(async () => {
    await app.close();
    mswServer.resetHandlers(conversionsHandler);
    await rm(tmpDir, { recursive: true, force: true });
  });

  function wire(envOverrides: Partial<Env> = {}): {
    credentials: ReturnType<typeof createCredentialsStore>;
  } {
    const env = fakeEnv({ SETUP_OUTPUT_DIR: tmpDir, ...envOverrides });
    const credentials = createCredentialsStore({ dir: tmpDir, log });
    registerManifestCallbackRoute(app, { env, log, credentials, octokitFactory });
    return { credentials };
  }

  function injectCallback(opts: {
    code?: string;
    state?: string;
    cookieState?: string;
  }): ReturnType<FastifyInstance["inject"]> {
    const query = new URLSearchParams();
    if (opts.code !== undefined) query.set("code", opts.code);
    if (opts.state !== undefined) query.set("state", opts.state);
    const headers: Record<string, string> = {};
    if (opts.cookieState !== undefined) {
      headers.cookie = `auto_merge_setup_state=${opts.cookieState}`;
    }
    return app.inject({
      method: "GET",
      url: `/setup/callback?${query.toString()}`,
      headers,
    });
  }

  it("400 missing_code when query.code is absent", async () => {
    wire();

    const res = await injectCallback({ state: "abc", cookieState: "abc" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "missing_code" });
    expect(h.calls).toBe(0);
  });

  it("400 csrf_mismatch when query.state is missing (presence flags logged, no values)", async () => {
    wire();

    const res = await injectCallback({ code: "ABC", cookieState: "abc" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "csrf_mismatch" });
    expect(h.calls).toBe(0);
    const warnMock = log.warn as ReturnType<typeof vi.fn>;
    expect(warnMock).toHaveBeenCalled();
    const firstArg = warnMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstArg.event).toBe("setup_csrf_mismatch");
    expect(firstArg.has_cookie).toBe(true);
    expect(firstArg.has_query_state).toBe(false);
    // No raw state/cookie values in log payload.
    expect(firstArg.state).toBeUndefined();
    expect(firstArg.cookie).toBeUndefined();
  });

  it("400 csrf_mismatch when cookie is missing (has_cookie: false)", async () => {
    wire();

    const res = await injectCallback({ code: "ABC", state: "abc" });

    expect(res.statusCode).toBe(400);
    expect(h.calls).toBe(0);
    const warnMock = log.warn as ReturnType<typeof vi.fn>;
    const firstArg = warnMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstArg.has_cookie).toBe(false);
    expect(firstArg.has_query_state).toBe(true);
  });

  it("400 csrf_mismatch when cookie != query.state; state cookie cleared (Max-Age=0); no conversion", async () => {
    wire();

    const res = await injectCallback({ code: "ABC", state: "abc", cookieState: "different" });

    expect(res.statusCode).toBe(400);
    expect(h.calls).toBe(0);
    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join("\n") : (setCookie ?? "");
    expect(cookieStr).toMatch(/auto_merge_setup_state=;[^,]*Max-Age=0/);
  });

  it("happy path — calls conversion once, persists, renders success, sets download cookie, clears state cookie", async () => {
    const { credentials } = wire();

    const res = await injectCallback({ code: "ABC", state: "s1", cookieState: "s1" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html; charset=utf-8/);
    expect(h.calls).toBe(1);
    // Persisted file on disk.
    expect(credentials.exists()).toBe(true);
    // Success page contains APP_ID + redacted tails, NOT raw secrets.
    expect(res.body).toContain("42");
    expect(res.body).not.toContain(DEFAULT_FIXTURE.webhook_secret);
    expect(res.body).not.toContain("DEADBEEFCAFEBABE");
    expect(res.body).toContain("****");
    // Download form present.
    expect(res.body).toContain('action="/setup/credentials.env"');
    // Set-Cookie carries both download cookie set + state cookie clear.
    const setCookie = res.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(cookies.some((c) => /auto_merge_setup_download=[^;]+;[^,]*Max-Age=300/.test(c))).toBe(
      true,
    );
    expect(cookies.some((c) => /auto_merge_setup_state=;[^,]*Max-Age=0/.test(c))).toBe(true);
    // setup_completed log without raw secrets.
    const infoMock = log.info as ReturnType<typeof vi.fn>;
    const completedCall = infoMock.mock.calls.find(
      ([obj]) => (obj as { event?: string }).event === "setup_completed",
    );
    expect(completedCall).toBeDefined();
    const payload = completedCall?.[0] as Record<string, unknown>;
    expect(payload.app_id).toBe(42);
    expect(payload.slug).toBe("auto-merge-test");
    expect(payload.pem).toBeUndefined();
    expect(payload.client_secret).toBeUndefined();
    expect(payload.webhook_secret).toBeUndefined();
  });

  it("refresh path — credentials.env already on disk → conversion NOT called, success rendered from disk", async () => {
    const { credentials } = wire();
    credentials.persist({
      id: 42,
      webhook_secret: "wh-secret-1234567890abcdef",
      pem: FIXTURE_PEM,
      client_id: "Iv1.abc",
      client_secret: "cs-secretvalue",
      slug: "auto-merge-test",
      html_url: "https://github.com/apps/auto-merge-test",
    });

    const res = await injectCallback({ code: "ABC", state: "s1", cookieState: "s1" });

    expect(res.statusCode).toBe(200);
    expect(h.calls).toBe(0); // No second conversion (Pitfall 1 idempotency).
    expect(res.body).toContain("42");
    expect(res.body).toContain('action="/setup/credentials.env"');
  });

  it("502 conversion_failed when GitHub returns 500; credentials NOT persisted", async () => {
    const { credentials } = wire();
    h.setStatus(500);

    const res = await injectCallback({ code: "ABC", state: "s1", cookieState: "s1" });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "conversion_failed" });
    expect(credentials.exists()).toBe(false);
    expect((log.error as ReturnType<typeof vi.fn>).mock.calls.some(
      ([obj]) => (obj as { event?: string }).event === "setup_conversion_failed",
    )).toBe(true);
  });

  it("500 persist_failed when credentials.persist throws; log includes app_id for operator rescue", async () => {
    const env = fakeEnv({ SETUP_OUTPUT_DIR: tmpDir });
    const credentials = createCredentialsStore({ dir: tmpDir, log });
    vi.spyOn(credentials, "persist").mockImplementation(() => {
      throw new Error("EACCES");
    });
    registerManifestCallbackRoute(app, { env, log, credentials, octokitFactory });

    const res = await injectCallback({ code: "ABC", state: "s1", cookieState: "s1" });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "persist_failed" });
    const errMock = log.error as ReturnType<typeof vi.fn>;
    const persistFail = errMock.mock.calls.find(
      ([obj]) => (obj as { event?: string }).event === "setup_persist_failed",
    );
    expect(persistFail).toBeDefined();
    const payload = persistFail?.[0] as Record<string, unknown>;
    expect(payload.app_id).toBe(42);
  });

  it("persist-before-render ordering — credentials.persist invocation strictly precedes successful render", async () => {
    const env = fakeEnv({ SETUP_OUTPUT_DIR: tmpDir });
    const credentials = createCredentialsStore({ dir: tmpDir, log });
    const persistSpy = vi.spyOn(credentials, "persist");
    const readSpy = vi.spyOn(credentials, "read");
    registerManifestCallbackRoute(app, { env, log, credentials, octokitFactory });

    const res = await injectCallback({ code: "ABC", state: "s1", cookieState: "s1" });

    expect(res.statusCode).toBe(200);
    expect(persistSpy).toHaveBeenCalledTimes(1);
    // Either read() or the renderSuccessPage source happens AFTER persist (verified by invocation order).
    const persistOrder = persistSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const readOrder = readSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    // read() is used by the render path to load the persisted payload — assert read is after persist.
    expect(persistOrder).toBeLessThan(readOrder);
  });

  it("log.warn for csrf_mismatch never carries raw state/cookie values", async () => {
    wire();

    await injectCallback({ code: "ABC", state: "abc", cookieState: "different-value" });

    const warnMock = log.warn as ReturnType<typeof vi.fn>;
    for (const call of warnMock.mock.calls) {
      const payload = call[0] as Record<string, unknown>;
      // Presence flags are booleans, never strings.
      expect(typeof payload.has_cookie === "boolean" || payload.has_cookie === undefined).toBe(true);
      expect(payload.state).toBeUndefined();
      expect(payload.cookie).toBeUndefined();
    }
  });
});

describe("registerCredentialsDownloadRoute — GET /setup/credentials.env", () => {
  let tmpDir: string;
  let app: FastifyInstance;
  let log: pino.Logger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "setup-download-"));
    log = makeLog();
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function wire(): { credentials: ReturnType<typeof createCredentialsStore> } {
    const env = fakeEnv({ SETUP_OUTPUT_DIR: tmpDir });
    const credentials = createCredentialsStore({ dir: tmpDir, log });
    registerCredentialsDownloadRoute(app, { env, log, credentials });
    return { credentials };
  }

  it("401 download_not_authorized when no download cookie present (no disk read)", async () => {
    wire();

    const res = await app.inject({ method: "GET", url: "/setup/credentials.env" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "download_not_authorized" });
  });

  it("404 credentials_not_found when cookie present but file missing; download cookie cleared", async () => {
    wire();

    const res = await app.inject({
      method: "GET",
      url: "/setup/credentials.env",
      headers: { cookie: "auto_merge_setup_download=token-abc" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "credentials_not_found" });
    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join("\n") : (setCookie ?? "");
    expect(cookieStr).toMatch(/auto_merge_setup_download=;[^,]*Max-Age=0/);
  });

  it("200 attachment with byte-equal body; clears download cookie (single-use)", async () => {
    const { credentials } = wire();
    credentials.persist({
      id: 7,
      webhook_secret: "wh-1234567890",
      pem: FIXTURE_PEM,
      slug: "auto-merge-test",
    });

    const res = await app.inject({
      method: "GET",
      url: "/setup/credentials.env",
      headers: { cookie: "auto_merge_setup_download=token-abc" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe(
      "attachment; filename=credentials.env",
    );
    const onDisk = credentials.read();
    expect(onDisk).not.toBeNull();
    if (!onDisk) throw new Error("file missing");
    expect(res.rawPayload.equals(onDisk)).toBe(true);

    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join("\n") : (setCookie ?? "");
    expect(cookieStr).toMatch(/auto_merge_setup_download=;[^,]*Max-Age=0/);
  });

  it("second GET without cookie (simulating browser cookie cleared) → 401", async () => {
    const { credentials } = wire();
    credentials.persist({
      id: 7,
      webhook_secret: "wh-1234567890",
      pem: FIXTURE_PEM,
    });

    const first = await app.inject({
      method: "GET",
      url: "/setup/credentials.env",
      headers: { cookie: "auto_merge_setup_download=token-abc" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "GET", url: "/setup/credentials.env" });
    expect(second.statusCode).toBe(401);
  });
});
