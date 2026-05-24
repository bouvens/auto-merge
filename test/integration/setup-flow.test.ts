import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import { initLogger } from "../../src/log.js";
import { buildServer } from "../../src/server.js";
import { createCredentialsStore } from "../../src/setup/credentials.js";
import { DOWNLOAD_COOKIE_NAME, STATE_COOKIE_NAME } from "../../src/setup/csrf.js";

const noopLog = initLogger({ LOG_LEVEL: "error", NODE_ENV: "test" });

function makeEnv(overrides: Partial<Env>): Env {
  return {
    APP_ID: 1,
    WEBHOOK_SECRET: "test-secret-1234567890",
    PORT: 3010,
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
    SETUP_APP_NAME: "auto-merge-e2e",
    SETUP_OUTPUT_DIR: "./data",
    DEFAULT_CONFIG_RELOAD_MS: 60_000,
    NOTIFY_DEDUP_MAX: 1000,
    NOTIFY_TIMEOUT_MS: 5000,
    NOTIFY_RETRY_ATTEMPTS: 3,
    NODE_ENV: "test",
    PRIVATE_KEY: "dummy",
    ...overrides,
  };
}

interface ConversionFixture {
  id: number;
  pem: string;
  webhook_secret: string;
  slug: string;
  html_url: string;
}

const conversionFixture: ConversionFixture = {
  id: 424242,
  pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBALabcdef\n-----END RSA PRIVATE KEY-----",
  webhook_secret: "whsec_abcdef1234567890wxyz",
  slug: "auto-merge-e2e-app",
  html_url: "https://github.com/apps/auto-merge-e2e-app",
};

let conversionCalls = 0;
const server = setupServer(
  http.post("https://api.github.com/app-manifests/:code/conversions", () => {
    conversionCalls += 1;
    return HttpResponse.json(conversionFixture, { status: 201 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

function readSetCookie(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? (raw as string[]) : [raw as string];
}

function extractCookieValue(setCookies: string[], name: string): string | undefined {
  for (const c of setCookies) {
    const first = c.split(";")[0] ?? "";
    const idx = first.indexOf("=");
    if (idx === -1) continue;
    if (first.slice(0, idx).trim() === name) {
      return first.slice(idx + 1).trim();
    }
  }
  return undefined;
}

function extractManifestState(html: string): string | undefined {
  const m = html.match(/name="manifest" value="([^"]+)"/);
  if (!m) return undefined;
  const decoded = m[1]!
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  try {
    const parsed = JSON.parse(decoded) as { state?: string };
    return parsed.state;
  } catch {
    return undefined;
  }
}

describe("Phase 8 end-to-end: setup-flow composition", () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "setup-flow-"));
    conversionCalls = 0;
  });

  afterEach(async () => {
    if (app) await app.close();
    server.resetHandlers(
      http.post("https://api.github.com/app-manifests/:code/conversions", () => {
        conversionCalls += 1;
        return HttpResponse.json(conversionFixture, { status: 201 });
      }),
    );
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("SETUP_ENABLED=false → all three setup routes return 404", async () => {
    const env = makeEnv({ SETUP_ENABLED: false });
    app = await buildServer({ env, log: noopLog });

    const newR = await app.inject({ method: "GET", url: "/setup/new" });
    const cbR = await app.inject({ method: "GET", url: "/setup/callback?code=X&state=Y" });
    const dlR = await app.inject({ method: "GET", url: "/setup/credentials.env" });

    expect(newR.statusCode).toBe(404);
    expect(cbR.statusCode).toBe(404);
    expect(dlR.statusCode).toBe(404);
  });

  it("SETUP_ENABLED=true → GET /setup/new issues state cookie and manifest with matching state field", async () => {
    const env = makeEnv({
      SETUP_ENABLED: true,
      SETUP_PUBLIC_URL: "https://example.test",
      SETUP_OUTPUT_DIR: tmpDir,
    });
    const credentials = createCredentialsStore({ dir: tmpDir, log: noopLog });
    app = await buildServer({ env, log: noopLog, credentials });

    const r = await app.inject({ method: "GET", url: "/setup/new" });
    expect(r.statusCode).toBe(200);

    const cookies = readSetCookie(r);
    const stateCookie = extractCookieValue(cookies, STATE_COOKIE_NAME);
    expect(stateCookie).toBeDefined();

    const manifestState = extractManifestState(r.body);
    expect(manifestState).toBeDefined();
    expect(manifestState).toBe(stateCookie);
  });

  it("happy path: GET /setup/callback with matching cookie+state persists credentials and renders success", async () => {
    const env = makeEnv({
      SETUP_ENABLED: true,
      SETUP_PUBLIC_URL: "https://example.test",
      SETUP_OUTPUT_DIR: tmpDir,
    });
    const credentials = createCredentialsStore({ dir: tmpDir, log: noopLog });
    app = await buildServer({ env, log: noopLog, credentials });

    const formR = await app.inject({ method: "GET", url: "/setup/new" });
    const state = extractCookieValue(readSetCookie(formR), STATE_COOKIE_NAME)!;

    const cbR = await app.inject({
      method: "GET",
      url: `/setup/callback?code=manifest-code-abc&state=${state}`,
      headers: { cookie: `${STATE_COOKIE_NAME}=${state}` },
    });

    expect(cbR.statusCode).toBe(200);
    expect(cbR.body).toContain("GitHub App создан");
    expect(cbR.body).toContain(String(conversionFixture.id));

    expect(conversionCalls).toBe(1);
    expect(existsSync(join(tmpDir, "credentials.env"))).toBe(true);

    const setCookies = readSetCookie(cbR);
    const dlCookie = extractCookieValue(setCookies, DOWNLOAD_COOKIE_NAME);
    expect(dlCookie).toBeDefined();
    expect(dlCookie).not.toBe("");
  });

  it("refresh idempotency: second GET /setup/callback with same state hits disk, conversion endpoint NOT re-called", async () => {
    const env = makeEnv({
      SETUP_ENABLED: true,
      SETUP_PUBLIC_URL: "https://example.test",
      SETUP_OUTPUT_DIR: tmpDir,
    });
    const credentials = createCredentialsStore({ dir: tmpDir, log: noopLog });
    app = await buildServer({ env, log: noopLog, credentials });

    const formR = await app.inject({ method: "GET", url: "/setup/new" });
    const state = extractCookieValue(readSetCookie(formR), STATE_COOKIE_NAME)!;

    const cb1 = await app.inject({
      method: "GET",
      url: `/setup/callback?code=manifest-code-abc&state=${state}`,
      headers: { cookie: `${STATE_COOKIE_NAME}=${state}` },
    });
    expect(cb1.statusCode).toBe(200);
    expect(conversionCalls).toBe(1);

    const cb2 = await app.inject({
      method: "GET",
      url: `/setup/callback?code=manifest-code-abc&state=${state}`,
      headers: { cookie: `${STATE_COOKIE_NAME}=${state}` },
    });
    expect(cb2.statusCode).toBe(200);
    expect(cb2.body).toContain("GitHub App создан");
    expect(conversionCalls).toBe(1);
  });

  it("duplicate setup: GET /setup/new with credentials present on disk renders warning, no state cookie", async () => {
    const env = makeEnv({
      SETUP_ENABLED: true,
      SETUP_PUBLIC_URL: "https://example.test",
      SETUP_OUTPUT_DIR: tmpDir,
    });
    const credentials = createCredentialsStore({ dir: tmpDir, log: noopLog });
    credentials.persist({
      id: conversionFixture.id,
      webhook_secret: conversionFixture.webhook_secret,
      pem: conversionFixture.pem,
      slug: conversionFixture.slug,
      html_url: conversionFixture.html_url,
    });

    app = await buildServer({ env, log: noopLog, credentials });

    const r = await app.inject({ method: "GET", url: "/setup/new" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("App уже сконфигурирован");
    expect(r.body).not.toContain('name="manifest"');

    const stateCookie = extractCookieValue(readSetCookie(r), STATE_COOKIE_NAME);
    expect(stateCookie).toBeUndefined();
  });

  it("gated download: GET /setup/credentials.env with download cookie returns file body byte-equal to disk", async () => {
    const env = makeEnv({
      SETUP_ENABLED: true,
      SETUP_PUBLIC_URL: "https://example.test",
      SETUP_OUTPUT_DIR: tmpDir,
    });
    const credentials = createCredentialsStore({ dir: tmpDir, log: noopLog });
    app = await buildServer({ env, log: noopLog, credentials });

    const formR = await app.inject({ method: "GET", url: "/setup/new" });
    const state = extractCookieValue(readSetCookie(formR), STATE_COOKIE_NAME)!;

    const cbR = await app.inject({
      method: "GET",
      url: `/setup/callback?code=manifest-code-abc&state=${state}`,
      headers: { cookie: `${STATE_COOKIE_NAME}=${state}` },
    });
    const dl = extractCookieValue(readSetCookie(cbR), DOWNLOAD_COOKIE_NAME)!;

    const downloadR = await app.inject({
      method: "GET",
      url: "/setup/credentials.env",
      headers: { cookie: `${DOWNLOAD_COOKIE_NAME}=${dl}` },
    });

    expect(downloadR.statusCode).toBe(200);
    expect(downloadR.headers["content-disposition"]).toContain(
      "attachment; filename=credentials.env",
    );

    const diskBody = readFileSync(join(tmpDir, "credentials.env"));
    expect(downloadR.rawPayload.equals(diskBody)).toBe(true);
  });
});
