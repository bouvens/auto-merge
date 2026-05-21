import { Octokit } from "@octokit/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupMswGitHub } from "../helpers/msw-github.js";

vi.mock("../../src/auth.js", () => ({
  getInstallationOctokit: vi.fn(async () => new Octokit({ baseUrl: "https://api.github.com" })),
  getAppOctokit: vi.fn(() => new Octokit({ baseUrl: "https://api.github.com" })),
  getBotIdentity: vi.fn(() => ({ id: 41898282, login: "auto-merge-test[bot]" })),
}));

import { getInstallationOctokit, getAppOctokit } from "../../src/auth.js";
import type { CascadeJob } from "../../src/cascade/orchestrator.js";
import { makeRunCascade } from "../../src/cascade/orchestrator.js";
import { log } from "../../src/log.js";
import { NoopChannel } from "../../src/notify/channel.js";
import { createMultiQueue } from "../../src/webhook/multiQueue.js";
import { runCronTick } from "../../src/cron/safetyNet.js";
import { sourceShaDedup } from "../../src/cascade/sourceShaDedup.js";

const harness = setupMswGitHub({
  branches: { main: "main-sha-001", release: "release-head", dev: "dev-head" },
  installations: [],
  installationRepos: {},
  currentInstallationId: null,
});

beforeAll(() => {
  harness.server.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  harness.server.close();
});

beforeEach(() => {
  harness.server.resetHandlers();
  harness.resetCounters();
  harness.state.branches = { main: "main-sha-001", release: "release-head", dev: "dev-head" };
  harness.state.mergeStatus = 201;
  harness.state.protection = null;
  harness.state.installations = [];
  harness.state.installationRepos = {};
  harness.state.currentInstallationId = null;
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  vi.spyOn(log, "debug").mockImplementation(() => undefined);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeInstOctokit() {
  return new Octokit({ baseUrl: "https://api.github.com" });
}

function makeAppOctokitInstance() {
  return new Octokit({ baseUrl: "https://api.github.com" });
}

describe("cron safety-net sweep", () => {
  it("happy path: 2 installations × 2 repos → 4 jobs enqueued", async () => {
    harness.state.installations = [
      { id: 11, suspended_at: null, account: { login: "org1" } },
      { id: 22, suspended_at: null, account: { login: "org2" } },
    ];
    harness.state.installationRepos = {
      11: [
        { name: "repo-a", full_name: "org1/repo-a", owner: { login: "org1" } },
        { name: "repo-b", full_name: "org1/repo-b", owner: { login: "org1" } },
      ],
      22: [
        { name: "repo-c", full_name: "org2/repo-c", owner: { login: "org2" } },
        { name: "repo-d", full_name: "org2/repo-d", owner: { login: "org2" } },
      ],
    };

    // Wire msw to identify installation from the token header — we use currentInstallationId.
    vi.mocked(getAppOctokit).mockReturnValue(makeAppOctokitInstance());
    vi.mocked(getInstallationOctokit).mockImplementation(async (id: number) => {
      harness.state.currentInstallationId = id;
      return makeInstOctokit();
    });

    let handlerCalls = 0;
    const queue = createMultiQueue<CascadeJob>({
      perKeyMax: 16,
      globalMax: 1000,
      handler: async () => { handlerCalls += 1; },
      notify: new NoopChannel(),
    });

    const result = await runCronTick({ multiQueue: queue });
    await queue.drain(3000);

    expect(result.installations).toBe(2);
    expect(result.repos_scanned).toBe(4);
    expect(result.jobs_enqueued).toBe(4);
    expect(handlerCalls).toBe(4);
    expect(harness.installationsCalls).toHaveLength(1);
    expect(harness.installationReposCalls).toHaveLength(2);
  });

  it("suspended installation skipped: 1 active → 2 repos enqueued", async () => {
    harness.state.installations = [
      { id: 11, suspended_at: "2026-01-01T00:00:00Z", account: { login: "org1" } },
      { id: 22, suspended_at: null, account: { login: "org2" } },
    ];
    harness.state.installationRepos = {
      11: [{ name: "repo-x", full_name: "org1/repo-x", owner: { login: "org1" } }],
      22: [
        { name: "repo-c", full_name: "org2/repo-c", owner: { login: "org2" } },
        { name: "repo-d", full_name: "org2/repo-d", owner: { login: "org2" } },
      ],
    };

    vi.mocked(getAppOctokit).mockReturnValue(makeAppOctokitInstance());
    vi.mocked(getInstallationOctokit).mockImplementation(async (id: number) => {
      harness.state.currentInstallationId = id;
      return makeInstOctokit();
    });

    let handlerCalls = 0;
    const queue = createMultiQueue<CascadeJob>({
      perKeyMax: 16,
      globalMax: 1000,
      handler: async () => { handlerCalls += 1; },
      notify: new NoopChannel(),
    });

    const result = await runCronTick({ multiQueue: queue });
    await queue.drain(3000);

    expect(result.installations).toBe(1);
    expect(result.repos_scanned).toBe(2);
    expect(handlerCalls).toBe(2);
    expect(harness.installationReposCalls).toHaveLength(1);
  });

  it("cron tick on same main HEAD twice: second tick deduped by orchestrator", async () => {
    harness.state.installations = [
      { id: 33, suspended_at: null, account: { login: "org3" } },
    ];
    harness.state.installationRepos = {
      33: [{ name: "repo-e", full_name: "org3/repo-e", owner: { login: "org3" } }],
    };
    harness.state.branches = {
      main: "dedup-sha-abc123",
      release: "release-head",
      dev: "dev-head",
    };

    vi.mocked(getAppOctokit).mockReturnValue(makeAppOctokitInstance());
    vi.mocked(getInstallationOctokit).mockImplementation(async (id: number) => {
      harness.state.currentInstallationId = id;
      return makeInstOctokit();
    });

    const cascadeLog: string[] = [];
    const infoImpl = vi.fn((obj: Record<string, unknown>) => {
      if (typeof obj?.event === "string") cascadeLog.push(obj.event);
    });
    vi.spyOn(log, "info").mockImplementation(infoImpl as unknown as typeof log.info);

    const runCascade = makeRunCascade({ notify: new NoopChannel() });
    const queue = createMultiQueue<CascadeJob>({
      perKeyMax: 16,
      globalMax: 1000,
      handler: runCascade,
      notify: new NoopChannel(),
    });

    // First tick — orchestrator resolves SHA and runs cascade
    await runCronTick({ multiQueue: queue });
    // Wait for handler to process
    await queue.drain(3000);

    // Second tick — same SHA → sourceShaDedup should produce cascade_skipped_dedup
    await runCronTick({ multiQueue: queue });
    await queue.drain(3000);

    const dedupEvents = cascadeLog.filter((e) => e === "cascade_skipped_dedup");
    expect(dedupEvents.length).toBeGreaterThanOrEqual(1);
  });
});
