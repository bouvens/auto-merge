import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cron } from "croner";
import type { CascadeJob } from "../../src/cascade/orchestrator.js";
import type { MultiQueue } from "../../src/webhook/multiQueue.js";

// Hoisted — vitest moves vi.mock calls to the top of the module before imports.
vi.mock("../../src/auth.js", () => ({
  getAppOctokit: vi.fn(),
  getInstallationOctokit: vi.fn(),
}));

vi.mock("../../src/log.js", () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { getAppOctokit, getInstallationOctokit } from "../../src/auth.js";
import { log as mockLog } from "../../src/log.js";
import { runCronTick, startCron, stopCronGracefully } from "../../src/cron/safetyNet.js";

function makeMockOctokit(listInstallationsPages: object[][], repoMap: Record<number, object[][]>) {
  let instPageIdx = 0;
  const appOctokit = {
    request: vi.fn(async (path: string, params: { per_page?: number; page?: number } = {}) => {
      if (path === "GET /app/installations") {
        const page = (params.page ?? 1) - 1;
        const data = listInstallationsPages[page] ?? [];
        return { data };
      }
      throw new Error(`Unexpected app request: ${path}`);
    }),
  };

  const makeInstOctokit = (installationId: number) => ({
    request: vi.fn(async (path: string, params: { per_page?: number; page?: number } = {}) => {
      if (path === "GET /installation/repositories") {
        const pages = repoMap[installationId] ?? [[]];
        const page = (params.page ?? 1) - 1;
        const repos = pages[page] ?? [];
        return { data: { repositories: repos } };
      }
      throw new Error(`Unexpected inst request: ${path}`);
    }),
  });

  return { appOctokit, makeInstOctokit };
}

function makeFakeMultiQueue(): MultiQueue<CascadeJob> & { calls: Array<{ key: string; jobId: string }> } {
  const calls: Array<{ key: string; jobId: string }> = [];
  return {
    calls,
    enqueue: vi.fn((key: string, job: { id: string }) => {
      calls.push({ key, jobId: job.id });
    }),
    drain: vi.fn(async () => {}),
    size: vi.fn(() => calls.length),
    keyCount: vi.fn(() => 0),
  };
}

describe("startCron — empty CRON_SCHEDULE", () => {
  it("logs cron_disabled and returns no-op stop", async () => {
    const infoSpy = vi.spyOn(mockLog, "info");
    const fakeEnv = { CRON_SCHEDULE: "", CRON_TZ: "UTC" } as Parameters<typeof startCron>[0]["env"];
    const fakeQueue = makeFakeMultiQueue();

    const handle = await startCron({ env: fakeEnv, multiQueue: fakeQueue, log: mockLog as Parameters<typeof startCron>[0]["log"] });

    expect(infoSpy).toHaveBeenCalledWith(expect.objectContaining({ event: "cron_disabled" }), "cron");
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(fakeQueue.size()).toBe(0);
  });
});

describe("protect:true skips overlapping tick", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("only one tick runs when a previous tick is still executing", async () => {
    const tickStarts: number[] = [];
    let release: (() => void) | null = null;

    const c = new Cron("* * * * * *", { protect: true }, async () => {
      tickStarts.push(Date.now());
      await new Promise<void>((r) => {
        release = r;
      });
    });

    await vi.advanceTimersByTimeAsync(1000); // tick 1 starts and blocks
    await vi.advanceTimersByTimeAsync(2000); // ticks 2 & 3 should be skipped
    release?.();
    c.stop();

    expect(tickStarts).toHaveLength(1);
  });
});

describe("runCronTick — pagination and enqueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("paginates installations and enqueues repos for each", async () => {
    const inst1 = { id: 10, suspended_at: null, account: { login: "org1" } };
    const inst2 = { id: 20, suspended_at: null, account: { login: "org2" } };
    const repo1 = { name: "repo-a", full_name: "org1/repo-a", owner: { login: "org1" } };
    const repo2 = { name: "repo-b", full_name: "org1/repo-b", owner: { login: "org1" } };
    const repo3 = { name: "repo-c", full_name: "org2/repo-c", owner: { login: "org2" } };
    const repo4 = { name: "repo-d", full_name: "org2/repo-d", owner: { login: "org2" } };

    const { appOctokit, makeInstOctokit } = makeMockOctokit(
      [[inst1, inst2]],
      { 10: [[repo1, repo2]], 20: [[repo3, repo4]] },
    );

    vi.mocked(getAppOctokit).mockReturnValue(appOctokit as ReturnType<typeof getAppOctokit>);
    vi.mocked(getInstallationOctokit).mockImplementation(async (id: number) =>
      makeInstOctokit(id) as Awaited<ReturnType<typeof getInstallationOctokit>>,
    );

    const fakeQueue = makeFakeMultiQueue();
    const result = await runCronTick({ multiQueue: fakeQueue });

    expect(result.installations).toBe(2);
    expect(result.repos_scanned).toBe(4);
    expect(result.jobs_enqueued).toBe(4);
    expect(fakeQueue.enqueue).toHaveBeenCalledTimes(4);

    const keys = fakeQueue.calls.map((c) => c.key);
    expect(keys).toContain("10/org1/repo-a");
    expect(keys).toContain("10/org1/repo-b");
    expect(keys).toContain("20/org2/repo-c");
    expect(keys).toContain("20/org2/repo-d");
  });

  it("skips suspended installation and logs debug event", async () => {
    const inst1 = { id: 10, suspended_at: "2026-01-01T00:00:00Z", account: { login: "org1" } };
    const inst2 = { id: 20, suspended_at: null, account: { login: "org2" } };
    const repo = { name: "repo-x", full_name: "org2/repo-x", owner: { login: "org2" } };

    const { appOctokit, makeInstOctokit } = makeMockOctokit(
      [[inst1, inst2]],
      { 20: [[repo]] },
    );

    vi.mocked(getAppOctokit).mockReturnValue(appOctokit as ReturnType<typeof getAppOctokit>);
    vi.mocked(getInstallationOctokit).mockImplementation(async (id: number) =>
      makeInstOctokit(id) as Awaited<ReturnType<typeof getInstallationOctokit>>,
    );

    const debugSpy = vi.spyOn(mockLog, "debug");
    const fakeQueue = makeFakeMultiQueue();
    const result = await runCronTick({ multiQueue: fakeQueue, log: mockLog as Parameters<typeof runCronTick>[0]["log"] });

    expect(result.installations).toBe(1);
    expect(result.repos_scanned).toBe(1);
    expect(fakeQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "cron_inst_suspended_skipped", installation_id: 10 }),
      "cron",
    );
  });

  it("continues on per-installation failure and logs warn", async () => {
    const inst1 = { id: 10, suspended_at: null, account: { login: "org1" } };
    const inst2 = { id: 20, suspended_at: null, account: { login: "org2" } };
    const repo = { name: "repo-ok", full_name: "org2/repo-ok", owner: { login: "org2" } };

    const appOctokit = {
      request: vi.fn(async (_path: string, _params: object) => ({
        data: [inst1, inst2],
      })),
    };

    // inst 10 throws 403, inst 20 is fine
    vi.mocked(getAppOctokit).mockReturnValue(appOctokit as ReturnType<typeof getAppOctokit>);
    vi.mocked(getInstallationOctokit).mockImplementation(async (id: number) => {
      if (id === 10) {
        const err = Object.assign(new Error("Forbidden"), { status: 403 });
        const badOctokit = {
          request: vi.fn(async () => { throw err; }),
        };
        return badOctokit as Awaited<ReturnType<typeof getInstallationOctokit>>;
      }
      return {
        request: vi.fn(async () => ({ data: { repositories: [repo] } })),
      } as Awaited<ReturnType<typeof getInstallationOctokit>>;
    });

    const warnSpy = vi.spyOn(mockLog, "warn");
    const fakeQueue = makeFakeMultiQueue();
    const result = await runCronTick({ multiQueue: fakeQueue, log: mockLog as Parameters<typeof runCronTick>[0]["log"] });

    expect(result.repos_scanned).toBe(1);
    expect(fakeQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "cron_installation_repos_failed", installation_id: 10 }),
      "cron",
    );
  });
});

describe("stopCronGracefully", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when cron is not busy and logs forced=false", async () => {
    const fakeCron = {
      stop: vi.fn(),
      isBusy: vi.fn(() => false),
    } as unknown as Cron;

    const infoSpy = vi.spyOn(mockLog, "info");
    await stopCronGracefully(fakeCron, 5000);

    expect(fakeCron.stop).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "shutdown_cron_stopped", forced: false }),
      "cron",
    );
  });

  it("logs forced=true when cron stays busy past timeout", async () => {
    const fakeCron = {
      stop: vi.fn(),
      isBusy: vi.fn(() => true),
    } as unknown as Cron;

    const warnSpy = vi.spyOn(mockLog, "warn");
    const promise = stopCronGracefully(fakeCron, 5000);
    await vi.runAllTimersAsync();
    await promise;

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "shutdown_cron_stopped", forced: true }),
      "cron",
    );
  });
});
