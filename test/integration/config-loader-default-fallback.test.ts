import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Octokit } from "@octokit/core";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initDefaultConfigLoader,
  stopDefaultConfigLoader,
} from "../../src/config/defaultLoader.js";
import { getRepoConfig, getRepoConfigSource, loadConfig } from "../../src/config/loader.js";
import { log } from "../../src/log.js";

const VALID_YAML = "main_branch: main\ndev_branch: dev\n";
const VALID_YAML_B64 = Buffer.from(VALID_YAML).toString("base64");

// Per-request counters keyed by URL + sha — reset in afterEach.
let contentsCallCount = 0;
let checkRunCallCount = 0;

const server = setupServer();

// Unauthenticated Octokit — msw intercepts before hitting the network.
const octokit = new Octokit();

// Unique sha per test prevents cross-test per-sha LRU contamination.
let testCounter = 0;
const nextSha = (): string => `sha-default-fallback-${++testCounter}`;

beforeAll(() => server.listen());

beforeEach(() => {
  contentsCallCount = 0;
  checkRunCallCount = 0;
  vi.spyOn(log, "info");
});

afterEach(() => {
  try {
    stopDefaultConfigLoader();
  } catch {
    // singleton may not be initialised in some tests — ignore
  }
  server.resetHandlers();
  vi.restoreAllMocks();
});

afterAll(() => server.close());

function contentsHandler200(): ReturnType<typeof http.get> {
  return http.get("https://api.github.com/repos/o/r/contents/.github%2Fauto-merge.yml", () => {
    contentsCallCount++;
    return HttpResponse.json({
      content: VALID_YAML_B64,
      encoding: "base64",
      type: "file",
      name: "auto-merge.yml",
      path: ".github/auto-merge.yml",
    });
  });
}

function contentsHandlerEmpty(): ReturnType<typeof http.get> {
  // Triggers `!data.content` branch — file-missing-branch, not the catch.
  return http.get("https://api.github.com/repos/o/r/contents/.github%2Fauto-merge.yml", () => {
    contentsCallCount++;
    return HttpResponse.json({
      content: "",
      encoding: "base64",
      type: "file",
      name: "auto-merge.yml",
      path: ".github/auto-merge.yml",
    });
  });
}

function contentsHandlerStatus(status: number): ReturnType<typeof http.get> {
  return http.get("https://api.github.com/repos/o/r/contents/.github%2Fauto-merge.yml", () => {
    contentsCallCount++;
    return new HttpResponse(JSON.stringify({ message: "Boom" }), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

function checkRunHandler(): ReturnType<typeof http.post> {
  return http.post("https://api.github.com/repos/o/r/check-runs", () => {
    checkRunCallCount++;
    return HttpResponse.json({ id: 1, status: "completed" }, { status: 201 });
  });
}

function configResolvedCalls(): Array<{ event: string; source: string }> {
  const spy = log.info as unknown as ReturnType<typeof vi.fn>;
  return spy.mock.calls
    .map((args) => args[0])
    .filter(
      (arg): arg is { event: string; source: string } =>
        typeof arg === "object" &&
        arg !== null &&
        (arg as { event?: unknown }).event === "config_resolved",
    );
}

describe("loadConfig — default fallback precedence (DEF-03)", () => {
  it("repo 200 + no default → source 'repo' (baseline regression)", async () => {
    server.use(contentsHandler200());

    const sha = nextSha();
    const result = await loadConfig({ octokit, owner: "o", repo: "r", sha, installation_id: 0 });

    expect(result.errors).toHaveLength(0);
    expect(result.config).toEqual({ main_branch: "main", dev_branch: "dev" });
    expect(result.source).toBe("repo");
    expect(getRepoConfigSource("o", "r")).toBe("repo");
    expect(checkRunCallCount).toBe(0);

    const resolved = configResolvedCalls();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.source).toBe("repo");
  });

  it("repo 404 file-missing branch + FILE default → source 'file_default', repoConfigCache populated, no Check Run", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "default-config-it-"));
    const filePath = join(tmpDir, "default.yml");
    await writeFile(filePath, VALID_YAML, "utf8");

    try {
      initDefaultConfigLoader(
        {
          DEFAULT_CASCADE_CONFIG_FILE: filePath,
          DEFAULT_CONFIG_RELOAD_MS: 60_000,
        },
        log,
      );

      server.use(contentsHandlerEmpty(), checkRunHandler());

      const sha = nextSha();
      const result = await loadConfig({ octokit, owner: "o", repo: "r", sha, installation_id: 0 });

      expect(result.errors).toHaveLength(0);
      expect(result.source).toBe("file_default");
      expect(result.config?.dev_branch).toBe("dev");
      expect(getRepoConfig("o", "r")?.dev_branch).toBe("dev");
      expect(getRepoConfigSource("o", "r")).toBe("file_default");
      // Critical: fallback must NOT trigger Check Run POST (success path).
      expect(checkRunCallCount).toBe(0);

      const resolved = configResolvedCalls();
      expect(resolved.some((c) => c.source === "file_default")).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("repo 404 catch branch + YAML default → source 'env_default', no Check Run", async () => {
    initDefaultConfigLoader(
      {
        DEFAULT_CASCADE_CONFIG_YAML: VALID_YAML,
        DEFAULT_CONFIG_RELOAD_MS: 60_000,
      },
      log,
    );

    server.use(contentsHandlerStatus(404), checkRunHandler());

    const sha = nextSha();
    const result = await loadConfig({ octokit, owner: "o", repo: "r", sha, installation_id: 0 });

    expect(result.errors).toHaveLength(0);
    expect(result.source).toBe("env_default");
    expect(result.config?.dev_branch).toBe("dev");
    expect(getRepoConfigSource("o", "r")).toBe("env_default");
    expect(checkRunCallCount).toBe(0);

    const resolved = configResolvedCalls();
    expect(resolved.some((c) => c.source === "env_default")).toBe(true);
  });

  it("repo 404 + no default initialised → existing failure path preserved (errors + Check Run)", async () => {
    // No initDefaultConfigLoader call here.
    server.use(contentsHandlerStatus(404), checkRunHandler());

    const sha = nextSha();
    const result = await loadConfig({ octokit, owner: "o", repo: "r", sha, installation_id: 0 });

    expect(result.errors).toHaveLength(1);
    expect(result.config).toBeUndefined();
    expect(result.source).toBeUndefined();
    expect(checkRunCallCount).toBe(1);
  });

  it("repo 403 + default initialised → fallback NOT applied (status !== 404)", async () => {
    initDefaultConfigLoader(
      {
        DEFAULT_CASCADE_CONFIG_YAML: VALID_YAML,
        DEFAULT_CONFIG_RELOAD_MS: 60_000,
      },
      log,
    );

    server.use(contentsHandlerStatus(403), checkRunHandler());

    const sha = nextSha();
    const result = await loadConfig({ octokit, owner: "o", repo: "r", sha, installation_id: 0 });

    expect(result.errors).toHaveLength(1);
    expect(result.source).toBeUndefined();
    expect(checkRunCallCount).toBe(1);
  });

  it("cache-hit on repo source does NOT re-log config_resolved (D-10)", async () => {
    server.use(contentsHandler200());

    const sha = nextSha();
    // First call: cache miss → populates per-sha LRU, logs config_resolved.
    await loadConfig({ octokit, owner: "o", repo: "r", sha, installation_id: 0 });
    const afterFirst = configResolvedCalls().length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // Second call with same sha: cache hit, no new log.
    await loadConfig({ octokit, owner: "o", repo: "r", sha, installation_id: 0 });
    const afterSecond = configResolvedCalls().length;
    expect(afterSecond).toBe(afterFirst);
    // And only one Contents API request was issued.
    expect(contentsCallCount).toBe(1);
  });
});
