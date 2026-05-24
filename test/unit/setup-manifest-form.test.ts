import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { createCredentialsStore } from "../../src/setup/credentials.js";
import {
  registerManifestFormRoute,
  renderManifestForm,
  renderWarningPage,
} from "../../src/setup/manifestForm.js";

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

const baseEnv: Pick<Env, "SETUP_APP_NAME" | "SETUP_PUBLIC_URL" | "NODE_ENV"> = {
  SETUP_APP_NAME: "auto-merge",
  SETUP_PUBLIC_URL: "https://example.test",
  NODE_ENV: "test",
};

// Decode HTML attr; entity order matters — &amp; must come last to avoid double-decode.
function decodeHtmlAttr(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("renderManifestForm — pure HTML renderer", () => {
  it("returns a string starting with <!doctype html>", () => {
    const html = renderManifestForm(baseEnv, "state-abc");
    expect(html.toLowerCase().startsWith("<!doctype html>")).toBe(true);
  });

  it("uses personal apps URL when org is undefined", () => {
    const html = renderManifestForm(baseEnv, "state-abc");
    expect(html).toContain('action="https://github.com/settings/apps/new"');
    expect(html).toMatch(/<form\b[^>]*method="post"/);
  });

  it("uses organisation-scoped URL when org is provided", () => {
    const html = renderManifestForm(baseEnv, "state-abc", "acme");
    expect(html).toContain('action="https://github.com/organizations/acme/settings/apps/new"');
  });

  it("embeds the manifest JSON via hidden input with HTML-escaped quotes", () => {
    const html = renderManifestForm(baseEnv, "state-xyz");
    const m = html.match(/name="manifest" value="([^"]+)"/);
    expect(m).not.toBeNull();
    if (!m) throw new Error("manifest input missing");
    const decoded = decodeHtmlAttr(m[1]!);
    const parsed = JSON.parse(decoded) as { state: string; name: string };
    expect(parsed.state).toBe("state-xyz");
    expect(parsed.name).toBe("auto-merge");
  });

  it("escapes SETUP_APP_NAME — visible-text portion has no raw <img", () => {
    const evil = { ...baseEnv, SETUP_APP_NAME: "<img src=x>" };
    const html = renderManifestForm(evil, "state-abc");
    const visible = html.replace(/<input type="hidden" name="manifest"[^>]*>/g, "");
    expect(visible).not.toContain("<img src=x>");
    expect(visible).toContain("&lt;img src=x&gt;");
  });

  it("contains an auto-submit script", () => {
    const html = renderManifestForm(baseEnv, "state-abc");
    expect(html).toMatch(/<script\b[\s\S]*\.submit\(\)[\s\S]*<\/script>/);
  });

  it("is pure — same args produce byte-identical output", () => {
    const a = renderManifestForm(baseEnv, "state-abc", "acme");
    const b = renderManifestForm(baseEnv, "state-abc", "acme");
    expect(a).toBe(b);
  });
});

describe("renderWarningPage — pure HTML renderer", () => {
  it("starts with <!doctype html> and contains the Russian warning headline", () => {
    const html = renderWarningPage(baseEnv, "/path/to/credentials.env");
    expect(html.toLowerCase().startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("App уже сконфигурирован");
  });

  it("shows the existing path (escaped) and 4 numbered recovery steps", () => {
    const html = renderWarningPage(baseEnv, "/data/credentials.env");
    expect(html).toContain("/data/credentials.env");
    const liCount = (html.match(/<li\b/g) ?? []).length;
    expect(liCount).toBeGreaterThanOrEqual(4);
  });

  it("contains override form with hidden force=1 and confirm input", () => {
    const html = renderWarningPage(baseEnv, "/data/credentials.env");
    expect(html).toMatch(/<form\b[^>]*method="get"[^>]*action="\/setup\/new"/);
    expect(html).toContain('name="force"');
    expect(html).toContain('value="1"');
    expect(html).toMatch(/<input[^>]*name="confirm"/);
  });

  it("escapes existingPath", () => {
    const html = renderWarningPage(baseEnv, "/data/<script>");
    expect(html).not.toContain("/data/<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("is pure — same args produce byte-identical output", () => {
    const a = renderWarningPage(baseEnv, "/data/credentials.env");
    const b = renderWarningPage(baseEnv, "/data/credentials.env");
    expect(a).toBe(b);
  });
});

type FullEnv = Pick<
  Env,
  "SETUP_APP_NAME" | "SETUP_PUBLIC_URL" | "SETUP_OUTPUT_DIR" | "SETUP_ENABLED" | "NODE_ENV"
>;

function fakeEnv(overrides: Partial<FullEnv> = {}): Env {
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

describe("registerManifestFormRoute — GET /setup/new", () => {
  let tmpDir: string;
  let app: FastifyInstance;
  let log: pino.Logger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "setup-manifest-form-"));
    log = makeLog();
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function wire(env: Env): { credentials: ReturnType<typeof createCredentialsStore> } {
    const credentials = createCredentialsStore({ dir: tmpDir, log });
    registerManifestFormRoute(app, { env, log, credentials });
    return { credentials };
  }

  it("200 HTML + state cookie + cache-control no-store when no credentials.env and no org", async () => {
    const env = fakeEnv({ SETUP_OUTPUT_DIR: tmpDir });
    wire(env);

    const res = await app.inject({ method: "GET", url: "/setup/new" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html; charset=utf-8/);
    expect(res.body.toLowerCase().startsWith("<!doctype")).toBe(true);
    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join("\n") : (setCookie ?? "");
    expect(cookieStr).toMatch(/^auto_merge_setup_state=[0-9a-f-]{36};/);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(
      (log.info as ReturnType<typeof vi.fn>).mock.calls.some(
        ([obj]) => (obj as { event?: string }).event === "setup_started",
      ),
    ).toBe(true);
  });

  it("200 with org-scoped form action when ?org=acme", async () => {
    const env = fakeEnv({ SETUP_OUTPUT_DIR: tmpDir });
    wire(env);

    const res = await app.inject({ method: "GET", url: "/setup/new?org=acme" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('action="https://github.com/organizations/acme/settings/apps/new"');
  });

  it("400 invalid_org with no Set-Cookie when ?org=../bad (path traversal)", async () => {
    const env = fakeEnv({ SETUP_OUTPUT_DIR: tmpDir });
    wire(env);

    const res = await app.inject({ method: "GET", url: "/setup/new?org=..%2Fbad" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_org" });
    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join("\n") : (setCookie ?? "");
    expect(cookieStr).not.toMatch(/auto_merge_setup_state=/);
  });

  it("400 invalid_org when ?org exceeds 39 chars", async () => {
    const env = fakeEnv({ SETUP_OUTPUT_DIR: tmpDir });
    wire(env);

    const longOrg = "a".repeat(40);
    const res = await app.inject({ method: "GET", url: `/setup/new?org=${longOrg}` });

    expect(res.statusCode).toBe(400);
  });

  it("state binding — Set-Cookie state matches manifest JSON state field", async () => {
    const env = fakeEnv({ SETUP_OUTPUT_DIR: tmpDir });
    wire(env);

    const res = await app.inject({ method: "GET", url: "/setup/new" });
    expect(res.statusCode).toBe(200);

    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join("\n") : (setCookie ?? "");
    const cookieMatch = cookieStr.match(/auto_merge_setup_state=([0-9a-f-]{36})/);
    expect(cookieMatch).not.toBeNull();
    const cookieState = cookieMatch?.[1];

    const inputMatch = res.body.match(/name="manifest" value="([^"]+)"/);
    expect(inputMatch).not.toBeNull();
    if (!inputMatch) throw new Error("manifest input missing");
    const json = JSON.parse(decodeHtmlAttr(inputMatch[1]!)) as { state: string };

    expect(json.state).toBe(cookieState);
  });

  it("warning page when credentials.env exists and no ?force=1 (no Set-Cookie state)", async () => {
    const env = fakeEnv({ SETUP_OUTPUT_DIR: tmpDir });
    const { credentials } = wire(env);
    credentials.persist({
      id: 1,
      webhook_secret: "x".repeat(40),
      pem: "-----BEGIN-----\n-----END-----\n",
    });

    const res = await app.inject({ method: "GET", url: "/setup/new" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("App уже сконфигурирован");
    expect(res.body).not.toMatch(/name="manifest"/);
    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join("\n") : (setCookie ?? "");
    expect(cookieStr).not.toMatch(/auto_merge_setup_state=/);
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("warning page when credentials.env exists and ?force=1 without confirm", async () => {
    const env = fakeEnv({ SETUP_OUTPUT_DIR: tmpDir });
    const { credentials } = wire(env);
    credentials.persist({
      id: 1,
      webhook_secret: "x".repeat(40),
      pem: "-----BEGIN-----\n-----END-----\n",
    });

    const res = await app.inject({ method: "GET", url: "/setup/new?force=1" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("App уже сконфигурирован");
    expect(res.body).not.toMatch(/name="manifest"/);
    expect(
      (log.warn as ReturnType<typeof vi.fn>).mock.calls.some(
        ([obj]) => (obj as { event?: string }).event === "setup_overwrite",
      ),
    ).toBe(false);
  });

  it("manifest form when credentials.env exists and ?force=1&confirm matches SETUP_APP_NAME", async () => {
    const env = fakeEnv({ SETUP_OUTPUT_DIR: tmpDir, SETUP_APP_NAME: "auto-merge" });
    const { credentials } = wire(env);
    credentials.persist({
      id: 1,
      webhook_secret: "x".repeat(40),
      pem: "-----BEGIN-----\n-----END-----\n",
    });

    const res = await app.inject({
      method: "GET",
      url: "/setup/new?force=1&confirm=auto-merge",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/name="manifest"/);
    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join("\n") : (setCookie ?? "");
    expect(cookieStr).toMatch(/auto_merge_setup_state=[0-9a-f-]{36};/);
    expect(
      (log.warn as ReturnType<typeof vi.fn>).mock.calls.some(
        ([obj]) => (obj as { event?: string }).event === "setup_overwrite",
      ),
    ).toBe(true);
  });

  it("warning page when ?force=1&confirm=wrong-name (silent fallback, no overwrite log)", async () => {
    const env = fakeEnv({ SETUP_OUTPUT_DIR: tmpDir, SETUP_APP_NAME: "auto-merge" });
    const { credentials } = wire(env);
    credentials.persist({
      id: 1,
      webhook_secret: "x".repeat(40),
      pem: "-----BEGIN-----\n-----END-----\n",
    });

    const res = await app.inject({
      method: "GET",
      url: "/setup/new?force=1&confirm=wrong-name",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("App уже сконфигурирован");
    expect(res.body).not.toMatch(/name="manifest"/);
    expect(
      (log.warn as ReturnType<typeof vi.fn>).mock.calls.some(
        ([obj]) => (obj as { event?: string }).event === "setup_overwrite",
      ),
    ).toBe(false);
  });
});
