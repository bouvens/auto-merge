import { Octokit } from "@octokit/core";
import { delay, HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { loadConfig as realLoadConfig } from "../config/loader.js";
import type { NotifyHealthChecker } from "../notify/healthCheck.js";
import { runProbes } from "./probes.js";

const REQUIRED_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  checks: "write",
  metadata: "read",
};

const FULL_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  checks: "write",
  metadata: "read",
};

const VALID_CONFIG = {
  main_branch: "main",
  release_branch: "release",
  dev_branch: "dev",
};

const silentLog = pino({ level: process.env.DEBUG_PROBES ? "debug" : "silent" });

function makeHealthChecker(
  slack: "ok" | "n/a" | "unreachable" | "misconfigured" | "pending" = "ok",
  telegram: "ok" | "n/a" | "unreachable" | "misconfigured" | "pending" = "n/a",
): NotifyHealthChecker & { getStatus: ReturnType<typeof vi.fn> } {
  const getStatus = vi.fn(() => ({ slack, telegram }));
  return {
    getStatus,
    refresh: vi.fn(async () => undefined),
  };
}

const octokitFactory = async () => new Octokit();

function makeLoadConfigStub(
  result: Awaited<ReturnType<typeof realLoadConfig>>,
): typeof realLoadConfig & { calls: Array<Parameters<typeof realLoadConfig>[0]> } {
  const calls: Array<Parameters<typeof realLoadConfig>[0]> = [];
  const stub = (async (deps: Parameters<typeof realLoadConfig>[0]) => {
    calls.push(deps);
    return result;
  }) as typeof realLoadConfig & { calls: typeof calls };
  stub.calls = calls;
  return stub;
}

const baseDeps = (overrides?: Partial<Parameters<typeof runProbes>[0]>) => {
  const appOctokit = new Octokit();
  const healthChecker = overrides?.healthChecker ?? makeHealthChecker();
  return {
    owner: "o",
    repo: "r",
    appOctokit,
    octokitFactory,
    healthChecker,
    log: silentLog,
    requiredPermissions: REQUIRED_PERMISSIONS,
    ...overrides,
  };
};

// Build a default-handler set returning healthy responses; per-test overrides via server.use().
function happyHandlers(opts?: { withProtection?: boolean }) {
  return [
    http.get("https://api.github.com/repos/o/r/installation", () =>
      HttpResponse.json({ id: 42, permissions: FULL_PERMISSIONS, events: ["push"] }),
    ),
    http.get("https://api.github.com/repos/o/r", () =>
      HttpResponse.json({ default_branch: "main" }),
    ),
    http.get("https://api.github.com/app/installations/42", () =>
      HttpResponse.json({ id: 42, permissions: FULL_PERMISSIONS, events: ["push"] }),
    ),
    http.get("https://api.github.com/repos/o/r/branches/:branch", ({ params }) =>
      HttpResponse.json({ name: params.branch, protected: !!opts?.withProtection }),
    ),
    http.get("https://api.github.com/repos/o/r/branches/:branch/protection", () =>
      opts?.withProtection
        ? HttpResponse.json({ restrictions: null })
        : HttpResponse.json({ message: "Branch not protected" }, { status: 404 }),
    ),
    http.get("https://api.github.com/repos/o/r/contents/.github%2Fauto-merge.yml", () =>
      HttpResponse.json({
        type: "file",
        path: ".github/auto-merge.yml",
        name: "auto-merge.yml",
      }),
    ),
    http.get("https://api.github.com/repos/o/r/pulls", () => HttpResponse.json([])),
  ];
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("runProbes", () => {
  it("happy path — every probe ok, onboarding=ok (config in repo)", async () => {
    server.use(...happyHandlers({ withProtection: true }));
    const loadConfigFn = makeLoadConfigStub({
      config: VALID_CONFIG,
      errors: [],
      source: "repo",
    });
    const healthChecker = makeHealthChecker("ok", "ok");
    const result = await runProbes({ ...baseDeps({ healthChecker }), loadConfigFn });

    expect(result.app_installed.status).toBe("ok");
    expect(result.app_installed.installation_id).toBe(42);
    expect(result.app_permissions.status).toBe("ok");
    expect(result.app_permissions.missing).toEqual([]);
    expect(result.config.status).toBe("ok");
    expect(result.config.source).toBe("repo");
    expect(result.config.main_branch).toBe("main");
    expect(result.branches.status).toBe("ok");
    expect(result.branches.branches.main?.protected).toBe(true);
    expect(result.notify.status).toBe("ok");
    expect(result.onboarding.status).toBe("ok");
    expect(result.onboarding.hint).toContain("config in repo");
    expect(healthChecker.getStatus).toHaveBeenCalledTimes(1);
    // loadConfig invoked with notify: undefined (no side effect on diagnose path).
    expect(loadConfigFn.calls).toHaveLength(1);
    expect(loadConfigFn.calls[0]?.notify).toBeUndefined();
  });

  it("app-not-installed: getRepoInstallation 404 — short-circuit, all other checks n/a", async () => {
    server.use(
      http.get("https://api.github.com/repos/o/r/installation", () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    const loadConfigFn = makeLoadConfigStub({ errors: [] });
    const result = await runProbes({ ...baseDeps(), loadConfigFn });

    expect(result.app_installed.status).toBe("error");
    expect(result.app_installed.detail).toBe("app-not-installed");
    expect(result.app_permissions.status).toBe("n/a");
    expect(result.config.status).toBe("n/a");
    expect(result.branches.status).toBe("n/a");
    expect(result.notify.status).toBe("n/a");
    expect(result.onboarding.status).toBe("n/a");
    // Downstream probes never fired — loadConfig stub was not called.
    expect(loadConfigFn.calls).toHaveLength(0);
  });

  it("permission gap: contents=read where required=write → missing includes 'contents'", async () => {
    const downgraded = { ...FULL_PERMISSIONS, contents: "read" };
    server.use(...happyHandlers({ withProtection: true }));
    // Re-registered last → MSW prefers the more recently defined matching handler.
    server.use(
      http.get("https://api.github.com/repos/o/r/installation", () =>
        HttpResponse.json({ id: 42, permissions: downgraded, events: ["push"] }),
      ),
      http.get("https://api.github.com/app/installations/:id", () =>
        HttpResponse.json({ id: 42, permissions: downgraded, events: ["push"] }),
      ),
    );
    const loadConfigFn = makeLoadConfigStub({
      config: VALID_CONFIG,
      errors: [],
      source: "repo",
    });
    const result = await runProbes({ ...baseDeps(), loadConfigFn });

    expect(result.app_permissions.status).toBe("error");
    expect(result.app_permissions.missing).toContain("contents");
    expect(result.app_permissions.missing).not.toContain("metadata");
  });

  it("file_default source + no repo file + no open PR → onboarding ok 'using org-default'", async () => {
    server.use(...happyHandlers());
    server.use(
      http.get("https://api.github.com/repos/o/r/contents/.github%2Fauto-merge.yml", () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    const loadConfigFn = makeLoadConfigStub({
      config: VALID_CONFIG,
      errors: [],
      source: "file_default",
    });
    const result = await runProbes({ ...baseDeps(), loadConfigFn });

    expect(result.onboarding.status).toBe("ok");
    expect(result.onboarding.config_present).toBe(false);
    expect(result.onboarding.hint).toContain("org-default");
    expect(result.onboarding.hint).toContain("file_default");
  });

  it("no repo file + no default + open PR → onboarding warn with PR url", async () => {
    server.use(...happyHandlers());
    server.use(
      http.get("https://api.github.com/repos/o/r/contents/.github%2Fauto-merge.yml", () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
      http.get("https://api.github.com/repos/o/r/pulls", () =>
        HttpResponse.json([{ number: 7, html_url: "https://github.com/o/r/pull/7" }]),
      ),
    );
    const loadConfigFn = makeLoadConfigStub({ errors: [{ line: 1, col: 1, message: "x" }] });
    const result = await runProbes({ ...baseDeps(), loadConfigFn });

    expect(result.onboarding.status).toBe("warn");
    expect(result.onboarding.open_pr).toEqual({
      number: 7,
      html_url: "https://github.com/o/r/pull/7",
    });
  });

  it("no repo file + no default + no PR → onboarding error 'run /setup'", async () => {
    server.use(...happyHandlers());
    server.use(
      http.get("https://api.github.com/repos/o/r/contents/.github%2Fauto-merge.yml", () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    const loadConfigFn = makeLoadConfigStub({ errors: [{ line: 1, col: 1, message: "x" }] });
    const result = await runProbes({ ...baseDeps(), loadConfigFn });

    expect(result.onboarding.status).toBe("error");
    expect(result.onboarding.hint).toContain("/setup");
  });

  it("getBranchProtection 404 → branch.protected=false (not an error)", async () => {
    server.use(...happyHandlers({ withProtection: false }));
    const loadConfigFn = makeLoadConfigStub({
      config: VALID_CONFIG,
      errors: [],
      source: "repo",
    });
    const result = await runProbes({ ...baseDeps(), loadConfigFn });

    expect(result.branches.branches.main?.exists).toBe(true);
    expect(result.branches.branches.main?.protected).toBe(false);
    // All branches exist → status warn (no protection), not error.
    expect(result.branches.status).toBe("warn");
  });

  it("per-call timeout: slow probe maps to error, siblings still complete (continue-on-error)", async () => {
    server.use(...happyHandlers({ withProtection: true }));
    server.use(
      // Pulls handler delays beyond per-call timeout → that single probe times out.
      http.get("https://api.github.com/repos/o/r/pulls", async () => {
        await delay(3500);
        return HttpResponse.json([]);
      }),
    );
    const loadConfigFn = makeLoadConfigStub({
      config: VALID_CONFIG,
      errors: [],
      source: "repo",
    });
    const result = await runProbes({ ...baseDeps(), loadConfigFn });

    // Other probes finished — full key-set present (SC1 invariant).
    expect(result.app_installed.status).toBe("ok");
    expect(result.config.status).toBe("ok");
    expect(result.branches.status).toBe("ok");
    // No open_pr surfaced (timeout treated as "no PR found").
    expect(result.onboarding.open_pr).toBeUndefined();
  }, 10_000);

  it("healthChecker.getStatus invoked exactly once per runProbes call", async () => {
    server.use(...happyHandlers({ withProtection: true }));
    const loadConfigFn = makeLoadConfigStub({
      config: VALID_CONFIG,
      errors: [],
      source: "repo",
    });
    const healthChecker = makeHealthChecker("ok", "ok");
    await runProbes({ ...baseDeps({ healthChecker }), loadConfigFn });
    expect(healthChecker.getStatus).toHaveBeenCalledTimes(1);
  });

  it("notify status derives from channel statuses: unreachable → error", async () => {
    server.use(...happyHandlers({ withProtection: true }));
    const loadConfigFn = makeLoadConfigStub({
      config: VALID_CONFIG,
      errors: [],
      source: "repo",
    });
    const healthChecker = makeHealthChecker("unreachable", "ok");
    const result = await runProbes({ ...baseDeps({ healthChecker }), loadConfigFn });
    expect(result.notify.status).toBe("error");
    expect(result.notify.slack).toBe("unreachable");
  });
});
