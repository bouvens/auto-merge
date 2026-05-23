import { utimesSync } from "node:fs";
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

// Composition test: real defaultLoader singleton + real loader.ts hooks + real fs + MSW network.
const server = setupServer();
const octokit = new Octokit();

let contentsCallCount = 0;
let checkRunCallCount = 0;
let testCounter = 0;
const nextSha = (): string => `sha-e2e-${++testCounter}`;

beforeAll(() => server.listen());
afterAll(() => server.close());

let tmpDir: string;
let filePath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "default-e2e-"));
  filePath = join(tmpDir, "default.yml");
  contentsCallCount = 0;
  checkRunCallCount = 0;
});

afterEach(async () => {
  try {
    stopDefaultConfigLoader();
  } catch {
    // singleton may be uninitialised in some tests
  }
  server.resetHandlers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

function contents404(): ReturnType<typeof http.get> {
  return http.get("https://api.github.com/repos/o/r/contents/.github%2Fauto-merge.yml", () => {
    contentsCallCount++;
    return new HttpResponse(JSON.stringify({ message: "Not Found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });
}

function checkRuns201(): ReturnType<typeof http.post> {
  return http.post("https://api.github.com/repos/o/r/check-runs", () => {
    checkRunCallCount++;
    return HttpResponse.json({ id: 1, status: "completed" }, { status: 201 });
  });
}

describe("Phase 7 end-to-end: defaultLoader + loader.ts composition", () => {
  it("404 + initDefaultConfigLoader(FILE) → file_default + repoConfigCache populated for notify resolver (D-09)", async () => {
    await writeFile(filePath, "main_branch: main\ndev_branch: dev\n", "utf8");
    initDefaultConfigLoader(
      { DEFAULT_CASCADE_CONFIG_FILE: filePath, DEFAULT_CONFIG_RELOAD_MS: 60_000 },
      log,
    );

    server.use(contents404(), checkRuns201());

    const result = await loadConfig({
      octokit,
      owner: "o",
      repo: "r",
      sha: nextSha(),
      installation_id: 1,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.source).toBe("file_default");
    expect(result.config?.dev_branch).toBe("dev");
    // D-09 notify resolver path: Slack/Telegram channels read getRepoConfig to derive cascade chains.
    expect(getRepoConfig("o", "r")?.dev_branch).toBe("dev");
    expect(getRepoConfigSource("o", "r")).toBe("file_default");
    expect(checkRunCallCount).toBe(0);
  });

  it("mtime bump + advance 60s → next loadConfig (new sha) returns reloaded default", async () => {
    await writeFile(filePath, "main_branch: main\ndev_branch: dev\n", "utf8");

    // Fake timers must cover the interval lifecycle from creation; toFake limits scope so MSW/undici timers stay real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    initDefaultConfigLoader(
      { DEFAULT_CASCADE_CONFIG_FILE: filePath, DEFAULT_CONFIG_RELOAD_MS: 60_000 },
      log,
    );

    server.use(contents404(), checkRuns201());

    const first = await loadConfig({
      octokit,
      owner: "o",
      repo: "r",
      sha: nextSha(),
      installation_id: 1,
    });
    expect(first.config?.dev_branch).toBe("dev");
    expect(first.source).toBe("file_default");

    await writeFile(filePath, "main_branch: main\ndev_branch: develop\n", "utf8");
    const future = new Date(Date.now() + 5_000);
    utimesSync(filePath, future, future);

    await vi.advanceTimersByTimeAsync(60_000);

    // Different sha forces per-sha LRU miss → re-hits 404 → fallback surfaces the reloaded default.
    const second = await loadConfig({
      octokit,
      owner: "o",
      repo: "r",
      sha: nextSha(),
      installation_id: 1,
    });
    expect(second.source).toBe("file_default");
    expect(second.config?.dev_branch).toBe("develop");
    expect(getRepoConfig("o", "r")?.dev_branch).toBe("develop");
    expect(checkRunCallCount).toBe(0);
  });

  it("stop() halts ticks; subsequent 404 with no default routes through failure path (Check Run)", async () => {
    await writeFile(filePath, "main_branch: main\ndev_branch: dev\n", "utf8");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    initDefaultConfigLoader(
      { DEFAULT_CASCADE_CONFIG_FILE: filePath, DEFAULT_CONFIG_RELOAD_MS: 60_000 },
      log,
    );

    // Tear down singleton — getDefaultConfig() now returns undefined.
    stopDefaultConfigLoader();

    await writeFile(filePath, "main_branch: main\ndev_branch: develop\n", "utf8");
    const future = new Date(Date.now() + 5_000);
    utimesSync(filePath, future, future);

    await vi.advanceTimersByTimeAsync(120_000);

    server.use(contents404(), checkRuns201());

    const result = await loadConfig({
      octokit,
      owner: "o",
      repo: "r",
      sha: nextSha(),
      installation_id: 1,
    });

    // No default → loader falls through to failure path → Check Run POST fires.
    expect(result.errors).toHaveLength(1);
    expect(result.source).toBeUndefined();
    expect(checkRunCallCount).toBe(1);
  });
});
