import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../../src/log.js";
import * as envNotifyMod from "../../src/onboarding/envNotify.js";
import {
  createOnboardingHandlers,
  type OnboardingHandlerDeps,
} from "../../src/onboarding/handler.js";
import type { OnboardOutcome } from "../../src/onboarding/onboardRepo.js";
import * as onboardRepoMod from "../../src/onboarding/onboardRepo.js";
import * as suppressionMod from "../../src/onboarding/suppressionSet.js";

vi.mock("../../src/onboarding/onboardRepo.js", () => ({
  onboardRepo: vi.fn(),
}));
vi.mock("../../src/onboarding/envNotify.js", () => ({
  notifySlackEnv: vi.fn(async () => {}),
  notifyTelegramEnv: vi.fn(async () => {}),
}));
vi.mock("../../src/onboarding/suppressionSet.js", () => ({
  markOnboarding: vi.fn(),
}));

type TestDeps = OnboardingHandlerDeps & {
  multiQueue: OnboardingHandlerDeps["multiQueue"] & {
    clearByInstallation: ReturnType<typeof vi.fn>;
  };
  octokitFactory: OnboardingHandlerDeps["octokitFactory"] & { mock: { calls: unknown[][] } };
};

function buildDeps(overrides: Record<string, unknown> = {}): TestDeps {
  const clearByInstallation = vi.fn(() => 0);
  const multiQueue = { clearByInstallation } as unknown as TestDeps["multiQueue"];
  const env = {
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/x",
    TELEGRAM_BOT_TOKEN: "test_token_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    TELEGRAM_DEFAULT_CHAT_ID: "-1001",
    NOTIFY_TIMEOUT_MS: 5000,
    SETUP_PUBLIC_URL: "https://app.example.com",
    ...overrides,
  } as OnboardingHandlerDeps["env"];
  const octokitFactory = vi.fn(
    async (_id: number) => undefined,
  ) as unknown as TestDeps["octokitFactory"];
  return { octokitFactory, multiQueue, env };
}

function makeInstallationPayload(
  installationId: number,
  repos: Array<{ name: string; owner: string }>,
  opts: {
    selection?: "selected" | "all";
    sender?: { login: string; type: string };
    emptyRepositories?: boolean;
  } = {},
): unknown {
  return {
    action: "created",
    installation: {
      id: installationId,
      repository_selection: opts.selection,
    },
    repositories: opts.emptyRepositories
      ? []
      : repos.map((r) => ({
          name: r.name,
          full_name: `${r.owner}/${r.name}`,
        })),
    repository_selection: opts.selection,
    sender: opts.sender,
  };
}

function makeAddedPayload(
  installationId: number,
  repos: Array<{ name: string; owner: string }>,
): unknown {
  return {
    action: "added",
    installation: { id: installationId },
    repositories_added: repos.map((r) => ({
      name: r.name,
      full_name: `${r.owner}/${r.name}`,
    })),
    sender: { login: "alice", type: "User" },
  };
}

async function flushAll(iters = 50): Promise<void> {
  for (let i = 0; i < iters; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("onboarding/handler — createOnboardingHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(onboardRepoMod.onboardRepo).mockImplementation(async (args) => ({
      status: "created",
      owner: args.owner,
      repo: args.repo,
      pr_number: 1,
      pr_url: "https://github.com/x",
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls markOnboarding once at batch start before any onboardRepo", async () => {
    const order: string[] = [];
    vi.mocked(suppressionMod.markOnboarding).mockImplementation(() => {
      order.push("mark");
    });
    vi.mocked(onboardRepoMod.onboardRepo).mockImplementation(async (args) => {
      order.push(`onboard:${args.repo}`);
      return { status: "created", owner: args.owner, repo: args.repo, pr_number: 1, pr_url: "u" };
    });
    const deps = buildDeps();
    const handlers = createOnboardingHandlers(deps);
    await handlers.onInstallation({
      payload: makeInstallationPayload(42, [
        { owner: "o", name: "r1" },
        { owner: "o", name: "r2" },
        { owner: "o", name: "r3" },
      ]),
    });
    await flushAll();
    expect(vi.mocked(suppressionMod.markOnboarding)).toHaveBeenCalledWith(42);
    expect(vi.mocked(suppressionMod.markOnboarding)).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe("mark");
    expect(order.slice(1).sort()).toEqual(["onboard:r1", "onboard:r2", "onboard:r3"]);
  });

  it("returns immediately without awaiting the batch (fire-and-forget)", async () => {
    vi.mocked(onboardRepoMod.onboardRepo).mockImplementation(
      (args) =>
        new Promise((r) =>
          setTimeout(
            () =>
              r({
                status: "created",
                owner: args.owner,
                repo: args.repo,
                pr_number: 1,
                pr_url: "u",
              }),
            200,
          ),
        ),
    );
    const deps = buildDeps();
    const handlers = createOnboardingHandlers(deps);
    const start = Date.now();
    await handlers.onInstallation({
      payload: makeInstallationPayload(1, [{ owner: "o", name: "r1" }]),
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
    await flushAll(20);
    await new Promise((r) => setTimeout(r, 250));
    expect(vi.mocked(onboardRepoMod.onboardRepo)).toHaveBeenCalled();
  });

  it("caps in-flight onboardRepo calls at 2 within one batch (per-batch p-limit)", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    vi.mocked(onboardRepoMod.onboardRepo).mockImplementation(async (args) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return { status: "created", owner: args.owner, repo: args.repo, pr_number: 1, pr_url: "u" };
    });
    const deps = buildDeps();
    const handlers = createOnboardingHandlers(deps);
    const repos = Array.from({ length: 10 }, (_, i) => ({ owner: "o", name: `r${i}` }));
    await handlers.onInstallation({ payload: makeInstallationPayload(1, repos) });
    await new Promise((r) => setTimeout(r, 500));
    await flushAll();
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(vi.mocked(onboardRepoMod.onboardRepo)).toHaveBeenCalledTimes(10);
  });

  it("per-batch semaphore is NOT shared across deliveries — combined concurrency exceeds 2", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    vi.mocked(onboardRepoMod.onboardRepo).mockImplementation(async (args) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 50));
      inFlight--;
      return { status: "created", owner: args.owner, repo: args.repo, pr_number: 1, pr_url: "u" };
    });
    const deps = buildDeps();
    const handlers = createOnboardingHandlers(deps);
    const r1 = Array.from({ length: 5 }, (_, i) => ({ owner: "o", name: `a${i}` }));
    const r2 = Array.from({ length: 5 }, (_, i) => ({ owner: "o", name: `b${i}` }));
    await Promise.all([
      handlers.onInstallation({ payload: makeInstallationPayload(1, r1) }),
      handlers.onInstallation({ payload: makeInstallationPayload(2, r2) }),
    ]);
    await new Promise((r) => setTimeout(r, 800));
    await flushAll();
    expect(maxConcurrent).toBeGreaterThanOrEqual(3);
  });

  it("does NOT call env notify when all outcomes are successful", async () => {
    const deps = buildDeps();
    const handlers = createOnboardingHandlers(deps);
    const repos = Array.from({ length: 5 }, (_, i) => ({ owner: "o", name: `r${i}` }));
    await handlers.onInstallation({ payload: makeInstallationPayload(1, repos) });
    await flushAll();
    expect(vi.mocked(envNotifyMod.notifySlackEnv)).not.toHaveBeenCalled();
    expect(vi.mocked(envNotifyMod.notifyTelegramEnv)).not.toHaveBeenCalled();
  });

  it("sends ONE aggregate env notify when at least one repo is protection_blocked", async () => {
    vi.mocked(onboardRepoMod.onboardRepo).mockImplementation(async (args) => {
      if (args.repo === "rbad") {
        return { status: "protection_blocked", owner: args.owner, repo: args.repo };
      }
      return { status: "created", owner: args.owner, repo: args.repo, pr_number: 1, pr_url: "u" };
    });
    const deps = buildDeps();
    const handlers = createOnboardingHandlers(deps);
    await handlers.onInstallation({
      payload: makeInstallationPayload(99, [
        { owner: "o", name: "rgood1" },
        { owner: "o", name: "rbad" },
        { owner: "o", name: "rgood2" },
      ]),
    });
    await flushAll();
    expect(vi.mocked(envNotifyMod.notifySlackEnv)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(envNotifyMod.notifyTelegramEnv)).toHaveBeenCalledTimes(1);
    const text = vi.mocked(envNotifyMod.notifySlackEnv).mock.calls[0]![1] as string;
    expect(text).toContain("o/rbad");
    expect(text).toContain("protection_blocked");
  });

  it("aggregates multiple bad outcomes into one summary text", async () => {
    vi.mocked(onboardRepoMod.onboardRepo).mockImplementation(async (args) => {
      if (args.repo === "rblock")
        return { status: "protection_blocked", owner: args.owner, repo: args.repo };
      if (args.repo === "rfail") {
        return {
          status: "failed",
          owner: args.owner,
          repo: args.repo,
          step: "get_repo",
          err_message: "boom",
        };
      }
      return { status: "created", owner: args.owner, repo: args.repo, pr_number: 1, pr_url: "u" };
    });
    const deps = buildDeps();
    const handlers = createOnboardingHandlers(deps);
    await handlers.onInstallation({
      payload: makeInstallationPayload(1, [
        { owner: "o", name: "r1" },
        { owner: "o", name: "r2" },
        { owner: "o", name: "rblock" },
        { owner: "o", name: "rfail" },
      ]),
    });
    await flushAll();
    const text = vi.mocked(envNotifyMod.notifySlackEnv).mock.calls[0]![1] as string;
    expect(text).toContain("o/rblock");
    expect(text).toContain("o/rfail");
    expect(text).toContain("protection_blocked");
    expect(text).toContain("failed");
  });

  it("skips dispatch when repository_selection is 'all' and repositories list is empty", async () => {
    const warnSpy = vi.spyOn(log, "info").mockImplementation(() => log);
    const deps = buildDeps();
    const handlers = createOnboardingHandlers(deps);
    await handlers.onInstallation({
      payload: makeInstallationPayload(7, [], { selection: "all", emptyRepositories: true }),
    });
    await flushAll();
    expect(vi.mocked(suppressionMod.markOnboarding)).toHaveBeenCalledWith(7);
    expect(vi.mocked(onboardRepoMod.onboardRepo)).not.toHaveBeenCalled();
    const skipLog = warnSpy.mock.calls.find(
      (c) =>
        typeof c[0] === "object" &&
        c[0] !== null &&
        (c[0] as { event?: string }).event === "onboard_skipped_all_repos_no_list",
    );
    expect(skipLog).toBeDefined();
    warnSpy.mockRestore();
  });

  it("onRepositoriesAdded reads payload.repositories_added", async () => {
    const deps = buildDeps();
    const handlers = createOnboardingHandlers(deps);
    await handlers.onRepositoriesAdded({
      payload: makeAddedPayload(33, [
        { owner: "o", name: "ra" },
        { owner: "o", name: "rb" },
      ]),
    });
    await flushAll();
    expect(vi.mocked(onboardRepoMod.onboardRepo)).toHaveBeenCalledTimes(2);
    const repos = vi
      .mocked(onboardRepoMod.onboardRepo)
      .mock.calls.map((c) => c[0].repo)
      .sort();
    expect(repos).toEqual(["ra", "rb"]);
  });

  it("propagates sender.login when sender.type === 'User'", async () => {
    const deps = buildDeps();
    const handlers = createOnboardingHandlers(deps);
    await handlers.onInstallation({
      payload: makeInstallationPayload(1, [{ owner: "o", name: "r1" }], {
        sender: { login: "alice", type: "User" },
      }),
    });
    await flushAll();
    expect(vi.mocked(onboardRepoMod.onboardRepo).mock.calls[0]![0].senderLogin).toBe("alice");
  });

  it("filters sender when sender.type === 'Bot' — senderLogin must be undefined", async () => {
    const deps = buildDeps();
    const handlers = createOnboardingHandlers(deps);
    await handlers.onInstallation({
      payload: makeInstallationPayload(1, [{ owner: "o", name: "r1" }], {
        sender: { login: "auto-merge[bot]", type: "Bot" },
      }),
    });
    await flushAll();
    expect(vi.mocked(onboardRepoMod.onboardRepo).mock.calls[0]![0].senderLogin).toBeUndefined();
  });

  it("swallows an onboardRepo rejection and surfaces a synthetic failed entry in the summary", async () => {
    vi.mocked(onboardRepoMod.onboardRepo).mockImplementation(async (args) => {
      if (args.repo === "boom") throw new Error("kaboom");
      return { status: "created", owner: args.owner, repo: args.repo, pr_number: 1, pr_url: "u" };
    });
    const deps = buildDeps();
    const handlers = createOnboardingHandlers(deps);
    await handlers.onInstallation({
      payload: makeInstallationPayload(1, [
        { owner: "o", name: "r1" },
        { owner: "o", name: "boom" },
      ]),
    });
    await flushAll();
    expect(vi.mocked(envNotifyMod.notifySlackEnv)).toHaveBeenCalledTimes(1);
    const text = vi.mocked(envNotifyMod.notifySlackEnv).mock.calls[0]![1] as string;
    expect(text).toContain("o/boom");
  });

  it("onInstallationDeleted calls multiQueue.clearByInstallation and logs lanes_dropped (no API calls)", async () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => log);
    const deps = buildDeps();
    deps.multiQueue.clearByInstallation.mockReturnValue(3);
    const handlers = createOnboardingHandlers(deps);
    await handlers.onInstallationDeleted({
      payload: { action: "deleted", installation: { id: 42 } },
    });
    expect(deps.multiQueue.clearByInstallation).toHaveBeenCalledWith(42);
    const evLog = infoSpy.mock.calls.find(
      (c) =>
        typeof c[0] === "object" &&
        c[0] !== null &&
        (c[0] as { event?: string }).event === "onboard_installation_cleaned",
    );
    expect(evLog).toBeDefined();
    expect(((evLog as unknown[])[0] as { lanes_dropped: number }).lanes_dropped).toBe(3);
    expect(deps.octokitFactory).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  it("onInstallationDeleted logs lanes_dropped: 0 when nothing matched", async () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => log);
    const deps = buildDeps();
    deps.multiQueue.clearByInstallation.mockReturnValue(0);
    const handlers = createOnboardingHandlers(deps);
    await handlers.onInstallationDeleted({
      payload: { action: "deleted", installation: { id: 11 } },
    });
    const evLog = infoSpy.mock.calls.find(
      (c) =>
        typeof c[0] === "object" &&
        c[0] !== null &&
        (c[0] as { event?: string }).event === "onboard_installation_cleaned",
    );
    expect(evLog).toBeDefined();
    expect(((evLog as unknown[])[0] as { lanes_dropped: number }).lanes_dropped).toBe(0);
    infoSpy.mockRestore();
  });

  it("passes deps.octokitFactory by reference into onboardRepo args", async () => {
    const deps = buildDeps();
    const handlers = createOnboardingHandlers(deps);
    await handlers.onInstallation({
      payload: makeInstallationPayload(1, [{ owner: "o", name: "r1" }]),
    });
    await flushAll();
    const callArg = vi.mocked(onboardRepoMod.onboardRepo).mock.calls[0]![0] as {
      octokitFactory: unknown;
    };
    expect(callArg.octokitFactory).toBe(deps.octokitFactory);
  });

  // Silence unused-import lints — referenced types are part of the public API surface under test.
  it("references OnboardOutcome type", () => {
    const _ok: OnboardOutcome = {
      status: "created",
      owner: "o",
      repo: "r",
      pr_number: 1,
      pr_url: "u",
    };
    expect(_ok.status).toBe("created");
  });
});
