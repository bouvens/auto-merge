import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";
import type { NotifyHealthChecker } from "../notify/healthCheck.js";
import {
  compareBearer,
  type DiagnoseDeps,
  parseBearer,
  REQUIRED_PERMISSIONS,
  registerDiagnoseRoute,
} from "./handler.js";
import type { DiagnoseChecks } from "./types.js";

const logger = pino({ level: "silent" });

function fakeEnv(overrides: Partial<Env> = {}): Env {
  // Minimal shape — handler only reads DIAGNOSE_TOKEN; cast keeps the test isolated from unrelated env fields.
  return {
    DIAGNOSE_TOKEN: "test-token-1234567890abcdef",
    ...overrides,
  } as Env;
}

function fakeChecks(): DiagnoseChecks {
  return {
    app_installed: { status: "ok", installation_id: 1 },
    app_permissions: {
      status: "ok",
      actual: { contents: "write" },
      required: REQUIRED_PERMISSIONS,
      missing: [],
    },
    config: { status: "ok", source: "repo", main_branch: "main", dev_branch: "dev" },
    branches: { status: "ok", branches: { main: { exists: true, protected: true } } },
    notify: { status: "ok", slack: "ok", telegram: "n/a" },
    onboarding: { status: "ok", config_present: true, hint: "config in repo" },
  };
}

function fakeHealthChecker(): NotifyHealthChecker {
  return {
    getStatus: () => ({ slack: "ok", telegram: "n/a" }),
    refresh: async () => {},
  };
}

interface BuildOpts {
  env?: Env;
  runProbesFn?: DiagnoseDeps["runProbesFn"];
  rateLimit?: DiagnoseDeps["rateLimit"];
}

async function buildApp(opts: BuildOpts = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });
  const deps: DiagnoseDeps = {
    env: opts.env ?? fakeEnv(),
    log: logger,
    // Cast to unknown — handler only invokes appOctokit via runProbesFn, which we stub in tests.
    appOctokit: {} as never,
    octokitFactory: async () => ({}) as never,
    healthChecker: fakeHealthChecker(),
    runProbesFn: opts.runProbesFn ?? (async () => fakeChecks()),
    rateLimit: opts.rateLimit,
  };
  registerDiagnoseRoute(app, deps);
  await app.ready();
  return app;
}

describe("parseBearer", () => {
  it("extracts token from `Bearer <token>`", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on scheme", () => {
    expect(parseBearer("bearer abc123")).toBe("abc123");
    expect(parseBearer("BEARER abc123")).toBe("abc123");
  });

  it("trims surrounding whitespace on the token", () => {
    expect(parseBearer("Bearer   abc123  ")).toBe("abc123");
  });

  it("returns undefined for missing header", () => {
    expect(parseBearer(undefined)).toBeUndefined();
  });

  it("returns undefined for non-Bearer schemes", () => {
    expect(parseBearer("Basic abc123")).toBeUndefined();
    expect(parseBearer("Token abc123")).toBeUndefined();
  });

  it("returns undefined when no token follows Bearer", () => {
    expect(parseBearer("Bearer")).toBeUndefined();
    expect(parseBearer("Bearer   ")).toBeUndefined();
  });
});

describe("compareBearer", () => {
  it("returns true on exact match", () => {
    expect(compareBearer("abc123", "abc123")).toBe(true);
  });

  it("returns false on length mismatch (without throwing)", () => {
    expect(compareBearer("short", "longer-string")).toBe(false);
  });

  it("returns false on equal-length wrong token", () => {
    expect(compareBearer("aaaaaa", "bbbbbb")).toBe(false);
  });
});

describe("registerDiagnoseRoute — 503 gate", () => {
  it("returns 503 with `diagnose-disabled` when DIAGNOSE_TOKEN is unset", async () => {
    const app = await buildApp({ env: fakeEnv({ DIAGNOSE_TOKEN: undefined }) });
    const res = await app.inject({ method: "GET", url: "/diagnose/o/r" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "diagnose-disabled" });
    await app.close();
  });

  it("503-gate fires BEFORE rate-limit (counter not incremented)", async () => {
    const checkSpy = vi.fn(() => ({ allowed: true }));
    const app = await buildApp({
      env: fakeEnv({ DIAGNOSE_TOKEN: undefined }),
      rateLimit: { check: checkSpy },
    });
    const res = await app.inject({ method: "GET", url: "/diagnose/o/r" });
    expect(res.statusCode).toBe(503);
    expect(checkSpy).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("registerDiagnoseRoute — auth", () => {
  it("returns 401 with empty body when Authorization header is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/diagnose/o/r" });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("");
    await app.close();
  });

  it("returns 401 on equal-length wrong token", async () => {
    const env = fakeEnv({ DIAGNOSE_TOKEN: "aaaaaaaaaaaaaaaaaaaaaaaa" });
    const app = await buildApp({ env });
    const res = await app.inject({
      method: "GET",
      url: "/diagnose/o/r",
      headers: { authorization: "Bearer bbbbbbbbbbbbbbbbbbbbbbbb" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("");
    await app.close();
  });

  it("returns 401 on length-mismatched wrong token (no throw)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/diagnose/o/r",
      headers: { authorization: "Bearer short" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 on non-Bearer auth scheme", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/diagnose/o/r",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("registerDiagnoseRoute — rate-limit", () => {
  it("returns 429 with Retry-After header when rate-limit denies", async () => {
    const app = await buildApp({
      rateLimit: { check: () => ({ allowed: false, retryAfterSec: 42 }) },
    });
    const res = await app.inject({ method: "GET", url: "/diagnose/o/r" });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("42");
    await app.close();
  });

  it("rate-limit runs BEFORE bearer-auth (denial wins regardless of auth)", async () => {
    const app = await buildApp({
      rateLimit: { check: () => ({ allowed: false, retryAfterSec: 5 }) },
    });
    const res = await app.inject({
      method: "GET",
      url: "/diagnose/o/r",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(429);
    await app.close();
  });

  it("real rate-limiter denies on 11th hit within window", async () => {
    // Use the actual factory to exercise the wired default path.
    const env = fakeEnv();
    const app = Fastify({ logger: false, trustProxy: true });
    registerDiagnoseRoute(app, {
      env,
      log: logger,
      appOctokit: {} as never,
      octokitFactory: async () => ({}) as never,
      healthChecker: fakeHealthChecker(),
      runProbesFn: async () => fakeChecks(),
    });
    await app.ready();
    const headers = { authorization: `Bearer ${env.DIAGNOSE_TOKEN}` };
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: "GET", url: "/diagnose/o/r", headers });
      expect(r.statusCode).toBe(200);
    }
    const eleventh = await app.inject({ method: "GET", url: "/diagnose/o/r", headers });
    expect(eleventh.statusCode).toBe(429);
    expect(Number(eleventh.headers["retry-after"])).toBeGreaterThan(0);
    await app.close();
  });
});

describe("registerDiagnoseRoute — success path & content negotiation", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it("returns 200 JSON by default with all D-10 sections", async () => {
    const env = fakeEnv();
    const res = await app.inject({
      method: "GET",
      url: "/diagnose/acme/widgets",
      headers: { authorization: `Bearer ${env.DIAGNOSE_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.owner).toBe("acme");
    expect(body.repo).toBe("widgets");
    expect(typeof body.checked_at).toBe("string");
    expect(body.checks).toMatchObject({
      app_installed: expect.any(Object),
      app_permissions: expect.any(Object),
      config: expect.any(Object),
      branches: expect.any(Object),
      notify: expect.any(Object),
      onboarding: expect.any(Object),
    });
    await app.close();
  });

  it("ok=false when any check is error", async () => {
    const checks = fakeChecks();
    checks.app_installed = { status: "error", detail: "app-not-installed" };
    const env = fakeEnv();
    const app2 = await buildApp({ runProbesFn: async () => checks });
    const res = await app2.inject({
      method: "GET",
      url: "/diagnose/o/r",
      headers: { authorization: `Bearer ${env.DIAGNOSE_TOKEN}` },
    });
    expect(res.json().ok).toBe(false);
    await app2.close();
  });

  it("returns markdown when Accept: text/markdown", async () => {
    const env = fakeEnv();
    const res = await app.inject({
      method: "GET",
      url: "/diagnose/acme/widgets",
      headers: {
        authorization: `Bearer ${env.DIAGNOSE_TOKEN}`,
        accept: "text/markdown",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.body.startsWith("# Diagnose: acme/widgets")).toBe(true);
    await app.close();
  });

  it("returns JSON when Accept is omitted (default per D-12)", async () => {
    const env = fakeEnv();
    const res = await app.inject({
      method: "GET",
      url: "/diagnose/o/r",
      headers: { authorization: `Bearer ${env.DIAGNOSE_TOKEN}` },
    });
    expect(res.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it("forwards REQUIRED_PERMISSIONS into runProbes call", async () => {
    const env = fakeEnv();
    const runner = vi.fn<NonNullable<DiagnoseDeps["runProbesFn"]>>(async () => fakeChecks());
    const app2 = await buildApp({ runProbesFn: runner });
    await app2.inject({
      method: "GET",
      url: "/diagnose/o/r",
      headers: { authorization: `Bearer ${env.DIAGNOSE_TOKEN}` },
    });
    expect(runner).toHaveBeenCalledOnce();
    const arg = runner.mock.calls[0]?.[0];
    expect(arg?.requiredPermissions).toEqual(REQUIRED_PERMISSIONS);
    expect(arg?.owner).toBe("o");
    expect(arg?.repo).toBe("r");
    await app2.close();
  });

  it("response body does not contain literal secret values", async () => {
    // T-10-13 — sanity guard: even with token in env, never echoed in body.
    const env = fakeEnv({ DIAGNOSE_TOKEN: "super-secret-token-do-not-leak" });
    const app2 = await buildApp({ env });
    const res = await app2.inject({
      method: "GET",
      url: "/diagnose/o/r",
      headers: { authorization: `Bearer ${env.DIAGNOSE_TOKEN}` },
    });
    expect(res.body).not.toContain("super-secret-token-do-not-leak");
    await app2.close();
  });
});

describe("REQUIRED_PERMISSIONS constant", () => {
  it("matches PROJECT.md Constraints set", () => {
    expect(REQUIRED_PERMISSIONS).toEqual({
      contents: "write",
      pull_requests: "write",
      checks: "write",
      metadata: "read",
    });
  });
});
