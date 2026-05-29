import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock all collaborating modules — orchestrator's job is pure dispatch logic, so we isolate it from real Octokit / GitHub API and assert call sequence and Check Run side effects.
vi.mock("../../src/cascade/plan.js", () => ({ buildCascadePlan: vi.fn() }));
vi.mock("../../src/cascade/merge.js", () => ({ mergeStep: vi.fn() }));
vi.mock("../../src/cascade/conflict.js", () => ({ createConflictPR: vi.fn() }));
vi.mock("../../src/cascade/checkRun.js", () => ({
  completeFailure: vi.fn(),
  createInProgress: vi.fn(),
}));
vi.mock("../../src/auth.js", () => ({
  getInstallationOctokit: vi.fn(async () => ({ request: vi.fn() })),
  getBotIdentity: vi.fn(() => ({ login: "my-app[bot]", email: "bot@noreply" })),
}));
vi.mock("../../src/config/loader.js", () => ({ loadConfig: vi.fn() }));

import { getBotIdentity, getInstallationOctokit } from "../../src/auth.js";
import { completeFailure, createInProgress } from "../../src/cascade/checkRun.js";
import { createConflictPR } from "../../src/cascade/conflict.js";
import { mergeStep } from "../../src/cascade/merge.js";
import { type CascadeJob, makeRunCascade, type PushJob } from "../../src/cascade/orchestrator.js";
import { buildCascadePlan } from "../../src/cascade/plan.js";
import { loadConfig } from "../../src/config/loader.js";
import { log } from "../../src/log.js";
import type { NotificationChannel, NotifyEvent } from "../../src/notify/channel.js";

const mergeStepMock = vi.mocked(mergeStep);
const buildCascadePlanMock = vi.mocked(buildCascadePlan);
const createConflictPRMock = vi.mocked(createConflictPR);
const completeFailureMock = vi.mocked(completeFailure);
const getInstallationOctokitMock = vi.mocked(getInstallationOctokit);
const loadConfigMock = vi.mocked(loadConfig);

const notifyEvents: NotifyEvent[] = [];
const mockNotify: NotificationChannel = {
  notify: vi.fn(async (e: NotifyEvent) => {
    notifyEvents.push(e);
  }),
};

function makeRunCascadeWithNoop() {
  return makeRunCascade({ notify: mockNotify });
}

const job = (overrides: Partial<PushJob> = {}) => ({
  id: "delivery-xyz",
  payload: {
    source: "push" as const,
    installation_id: 42,
    owner: "acme",
    repo: "widgets",
    branch: "main",
    after: "src1234",
    before: "before1",
    sender_login: "user",
    head_commit: {
      id: "src1234",
      message: "regular commit",
      author: { name: "User", email: "user@example.com", username: "user" },
    },
    config: {
      main_branch: "main",
      release_branch: "release",
      dev_branch: "dev",
    },
    ...overrides,
  } as PushJob,
});

const cronJob = (overrides: Partial<Extract<CascadeJob, { source: "cron" }>> = {}) => ({
  id: "cron-job-1",
  payload: {
    source: "cron" as const,
    installation_id: 42,
    owner: "acme",
    repo: "widgets",
    after: null,
    ...overrides,
  } as Extract<CascadeJob, { source: "cron" }>,
});

let infoSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  notifyEvents.length = 0;
  getInstallationOctokitMock.mockResolvedValue({ request: vi.fn() } as never);
  vi.mocked(getBotIdentity).mockReturnValue({ login: "my-app[bot]", email: "bot@noreply" });
  infoSpy = vi.spyOn(log, "info").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined);
  warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
});

describe("runCascade (via makeRunCascade)", () => {
  it("two-pair plan, both merged → both pairs visited, no completeFailure, no createConflictPR", async () => {
    buildCascadePlanMock.mockResolvedValue([
      { src: "main", tgt: "release" },
      { src: "release", tgt: "dev" },
    ]);
    mergeStepMock.mockResolvedValue({ outcome: "merged", sha: "abc", check_run_id: 1 });

    await makeRunCascadeWithNoop()(job());

    expect(mergeStepMock).toHaveBeenCalledTimes(2);
    expect(completeFailureMock).not.toHaveBeenCalled();
    expect(createConflictPRMock).not.toHaveBeenCalled();
  });

  it("two-pair plan, first pair conflict → createConflictPR once, completeFailure once with real_conflict + pr_url, second pair NOT visited", async () => {
    buildCascadePlanMock.mockResolvedValue([
      { src: "main", tgt: "release" },
      { src: "release", tgt: "dev" },
    ]);
    mergeStepMock.mockResolvedValueOnce({
      outcome: "conflict",
      source_sha: "src1234",
      check_run_id: 7,
      check_run_html_url: "https://gh/cr/7",
    });
    createConflictPRMock.mockResolvedValue({
      ok: true,
      pr_url: "https://gh/pr/9",
      pr_number: 9,
      reused: false,
    });

    await makeRunCascadeWithNoop()(job());

    expect(mergeStepMock).toHaveBeenCalledTimes(1);
    expect(createConflictPRMock).toHaveBeenCalledTimes(1);
    expect(completeFailureMock).toHaveBeenCalledTimes(1);
    const failArg = completeFailureMock.mock.calls[0]![1];
    expect(failArg.kind).toBe("real_conflict");
    expect(failArg.detail).toBe("https://gh/pr/9");
    expect(failArg.check_run_id).toBe(7);
  });

  it("single-pair plan, unknown_error → completeFailure with kind=unknown_error, no createConflictPR", async () => {
    buildCascadePlanMock.mockResolvedValue([{ src: "main", tgt: "dev" }]);
    mergeStepMock.mockResolvedValueOnce({
      outcome: "unknown_error",
      status: 500,
      message: "boom",
      check_run_id: 11,
    });

    await makeRunCascadeWithNoop()(job({ branch: "main" }));

    expect(createConflictPRMock).not.toHaveBeenCalled();
    expect(completeFailureMock).toHaveBeenCalledTimes(1);
    const failArg = completeFailureMock.mock.calls[0]![1];
    expect(failArg.kind).toBe("unknown_error");
    expect(failArg.detail).toContain("500");
    expect(failArg.detail).toContain("boom");
  });

  it("createConflictPR returns ok=false → completeFailure detail contains 'conflict PR failed'", async () => {
    buildCascadePlanMock.mockResolvedValue([{ src: "main", tgt: "release" }]);
    mergeStepMock.mockResolvedValueOnce({
      outcome: "conflict",
      source_sha: "src1234",
      check_run_id: 7,
      check_run_html_url: null,
    });
    createConflictPRMock.mockResolvedValue({ ok: false, error: "createRef 500" });

    await makeRunCascadeWithNoop()(job());

    expect(completeFailureMock).toHaveBeenCalledTimes(1);
    const failArg = completeFailureMock.mock.calls[0]![1];
    expect(failArg.kind).toBe("real_conflict");
    expect(failArg.detail).toContain("conflict PR failed");
    expect(failArg.detail).toContain("createRef 500");
  });

  it("buildCascadePlan throws → cascade_failed logged, mergeStep NOT called", async () => {
    buildCascadePlanMock.mockRejectedValue(new Error("getBranch 503"));

    await makeRunCascadeWithNoop()(job());

    expect(mergeStepMock).not.toHaveBeenCalled();
    expect(completeFailureMock).not.toHaveBeenCalled();
    const errorEvents = errorSpy.mock.calls
      .map((c: unknown[]) => (c[0] as { event?: string })?.event)
      .filter(Boolean);
    expect(errorEvents).toContain("cascade_failed");
  });

  it("synthetic error inside loop → cascade_failed logged, no rethrow", async () => {
    buildCascadePlanMock.mockResolvedValue([{ src: "main", tgt: "dev" }]);
    mergeStepMock.mockImplementationOnce(async () => {
      throw new Error("network drop");
    });

    await expect(makeRunCascadeWithNoop()(job())).resolves.toBeUndefined();
    const errorEvents = errorSpy.mock.calls
      .map((c: unknown[]) => (c[0] as { event?: string })?.event)
      .filter(Boolean);
    expect(errorEvents).toContain("cascade_failed");
  });

  it("skipped outcome on first pair, merged on second → both visited, no completeFailure", async () => {
    buildCascadePlanMock.mockResolvedValue([
      { src: "main", tgt: "release" },
      { src: "release", tgt: "dev" },
    ]);
    mergeStepMock
      .mockResolvedValueOnce({ outcome: "skipped", reason: "ahead_by_zero" })
      .mockResolvedValueOnce({ outcome: "merged", sha: "xyz", check_run_id: 2 });

    await makeRunCascadeWithNoop()(job());

    expect(mergeStepMock).toHaveBeenCalledTimes(2);
    expect(completeFailureMock).not.toHaveBeenCalled();
  });

  it("runId is a valid UUID v4 string in cascade_started log", async () => {
    buildCascadePlanMock.mockResolvedValue([]);

    await makeRunCascadeWithNoop()(job());

    const started = infoSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as { event?: string })?.event === "cascade_started",
    );
    expect(started).toBeDefined();
    const runId = (started![0] as { run_id: string }).run_id;
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("protection_blocked → createConflictPR with summaryPrefix, completeFailure with protection_blocked kind, notify called, break", async () => {
    buildCascadePlanMock.mockResolvedValue([
      { src: "main", tgt: "release" },
      { src: "release", tgt: "dev" },
    ]);
    mergeStepMock.mockResolvedValueOnce({
      outcome: "protection_blocked",
      rule: "required_pull_request_reviews",
      source_sha: "src1234",
      check_run_id: null,
      check_run_html_url: null,
    });
    createConflictPRMock.mockResolvedValue({
      ok: true,
      pr_url: "https://gh/pr/11",
      pr_number: 11,
      reused: false,
    });
    vi.mocked(createInProgress).mockResolvedValue({
      check_run_id: 99,
      html_url: "https://gh/cr/99",
    });

    await makeRunCascadeWithNoop()(job());

    expect(mergeStepMock).toHaveBeenCalledTimes(1);
    expect(createConflictPRMock).toHaveBeenCalledTimes(1);
    const prArg = createConflictPRMock.mock.calls[0]![1];
    expect((prArg as { summaryPrefix?: string }).summaryPrefix).toBe(
      "Blocked by branch protection: required_pull_request_reviews",
    );
    expect(completeFailureMock).toHaveBeenCalledTimes(1);
    const failArg = completeFailureMock.mock.calls[0]![1];
    expect(failArg.kind).toBe("protection_blocked");
    const notifyCall = notifyEvents.find((e) => e.kind === "protection_blocked");
    expect(notifyCall).toBeDefined();
    if (notifyCall?.kind === "protection_blocked") {
      expect(notifyCall.rule).toBe("required_pull_request_reviews");
    }
  });

  describe("conflict notify gate (reused PR)", () => {
    it("new PR (reused:false) → cascade_conflict notify fires once", async () => {
      buildCascadePlanMock.mockResolvedValue([{ src: "main", tgt: "release" }]);
      mergeStepMock.mockResolvedValueOnce({
        outcome: "conflict",
        source_sha: "src1234",
        check_run_id: 7,
        check_run_html_url: "https://gh/cr/7",
      });
      createConflictPRMock.mockResolvedValue({
        ok: true,
        pr_url: "https://gh/pr/9",
        pr_number: 9,
        reused: false,
      });

      await makeRunCascadeWithNoop()(job());

      expect(notifyEvents.filter((e) => e.kind === "cascade_conflict")).toHaveLength(1);
      const ev = notifyEvents.find((e) => e.kind === "cascade_conflict");
      expect(ev?.kind === "cascade_conflict" && ev.pr_url).toBe("https://gh/pr/9");
    });

    it("reused PR (reused:true) → cascade_conflict notify suppressed, completeFailure still called", async () => {
      buildCascadePlanMock.mockResolvedValue([{ src: "main", tgt: "release" }]);
      mergeStepMock.mockResolvedValueOnce({
        outcome: "conflict",
        source_sha: "src1234",
        check_run_id: 7,
        check_run_html_url: "https://gh/cr/7",
      });
      createConflictPRMock.mockResolvedValue({
        ok: true,
        pr_url: "https://gh/pr/9",
        pr_number: 9,
        reused: true,
      });

      await makeRunCascadeWithNoop()(job());

      expect(notifyEvents.filter((e) => e.kind === "cascade_conflict")).toHaveLength(0);
      expect(completeFailureMock).toHaveBeenCalledTimes(1);
      const suppressedLog = infoSpy.mock.calls.find(
        (c: unknown[]) =>
          (c[0] as { event?: string })?.event === "cascade_conflict_notification_suppressed",
      );
      expect(suppressedLog).toBeDefined();
    });

    it("PR creation failed (ok:false) → cascade_conflict notify still fires with pr_url=''", async () => {
      buildCascadePlanMock.mockResolvedValue([{ src: "main", tgt: "release" }]);
      mergeStepMock.mockResolvedValueOnce({
        outcome: "conflict",
        source_sha: "src1234",
        check_run_id: 7,
        check_run_html_url: null,
      });
      createConflictPRMock.mockResolvedValue({ ok: false, error: "boom" });

      await makeRunCascadeWithNoop()(job());

      expect(notifyEvents.filter((e) => e.kind === "cascade_conflict")).toHaveLength(1);
      const ev = notifyEvents.find((e) => e.kind === "cascade_conflict");
      expect(ev?.kind === "cascade_conflict" && ev.pr_url).toBe("");
    });
  });

  it("permission_error → NO createConflictPR, completeFailure called, notify called, break", async () => {
    buildCascadePlanMock.mockResolvedValue([
      { src: "main", tgt: "release" },
      { src: "release", tgt: "dev" },
    ]);
    mergeStepMock.mockResolvedValueOnce({
      outcome: "permission_error",
      endpoint: "merges",
      status: 403,
      missing_permission: "contents:write",
      check_run_id: 55,
    });

    await makeRunCascadeWithNoop()(job());

    expect(mergeStepMock).toHaveBeenCalledTimes(1);
    expect(createConflictPRMock).not.toHaveBeenCalled();
    expect(completeFailureMock).toHaveBeenCalledTimes(1);
    const failArg = completeFailureMock.mock.calls[0]![1];
    expect(failArg.kind).toBe("permission_error");
    const notifyCall = notifyEvents.find((e) => e.kind === "permission_error");
    expect(notifyCall).toBeDefined();
    if (notifyCall?.kind === "permission_error") {
      expect(notifyCall.endpoint).toBe("merges");
      expect(notifyCall.missing_permission).toBe("contents:write");
    }
  });

  it("cron source → loadConfig called, octokit.request GET /branches used to resolve SHA, mergeStep called", async () => {
    const fakeOctokit = {
      request: vi.fn(async (route: string) => {
        if (route === "GET /repos/{owner}/{repo}/branches/{branch}") {
          return { data: { commit: { sha: "cron-resolved-sha" } } };
        }
        throw new Error(`unexpected: ${route}`);
      }),
    };
    getInstallationOctokitMock.mockResolvedValue(fakeOctokit as never);
    loadConfigMock.mockResolvedValue({
      config: { main_branch: "main", release_branch: "release", dev_branch: "dev" },
      errors: [],
    });
    buildCascadePlanMock.mockResolvedValue([{ src: "main", tgt: "release" }]);
    mergeStepMock.mockResolvedValue({ outcome: "merged", sha: "xxx", check_run_id: null });

    await makeRunCascadeWithNoop()(cronJob());

    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(mergeStepMock).toHaveBeenCalledTimes(1);
    const deps = mergeStepMock.mock.calls[0]![0];
    expect(
      (deps as { source_sha?: string }).source_sha ??
        (mergeStepMock.mock.calls[0]![1] as { source_sha: string }).source_sha,
    ).toBe("cron-resolved-sha");
  });

  it("dispatch source → cascade_started log includes sender_login from job payload", async () => {
    const fakeOctokit = {
      request: vi.fn(async (route: string) => {
        if (route === "GET /repos/{owner}/{repo}/branches/{branch}") {
          return { data: { commit: { sha: "dispatch-sha" } } };
        }
        throw new Error(`unexpected: ${route}`);
      }),
    };
    getInstallationOctokitMock.mockResolvedValue(fakeOctokit as never);
    loadConfigMock.mockResolvedValue({
      config: { main_branch: "main", release_branch: "release", dev_branch: "dev" },
      errors: [],
    });
    buildCascadePlanMock.mockResolvedValue([]);

    const dispatchJob = {
      id: "dispatch-1",
      payload: {
        source: "dispatch" as const,
        installation_id: 42,
        owner: "acme",
        repo: "widgets",
        after: null,
        sender: { login: "deploy-bot" },
      },
    };

    await makeRunCascadeWithNoop()(dispatchJob);

    const started = infoSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as { event?: string })?.event === "cascade_started",
    );
    expect(started).toBeDefined();
    expect((started![0] as { sender_login?: string }).sender_login).toBe("deploy-bot");
  });

  describe("cron/dispatch HEAD commit author resolution", () => {
    function makeCronOctokit(sha: string, commitResponse: unknown, throwOnCommit = false) {
      return {
        request: vi.fn(async (route: string) => {
          if (route === "GET /repos/{owner}/{repo}/branches/{branch}") {
            return { data: { commit: { sha } } };
          }
          if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
            if (throwOnCommit) throw new Error("API timeout");
            return commitResponse;
          }
          throw new Error(`unexpected route: ${route}`);
        }),
      };
    }

    it("cron path resolves author login from commit API, flows into notify payload", async () => {
      const fakeOctokit = makeCronOctokit("cron-author-sha-1", {
        data: { author: { login: "alice" }, commit: { author: { email: "alice@example.com" } } },
      });
      getInstallationOctokitMock.mockResolvedValue(fakeOctokit as never);
      loadConfigMock.mockResolvedValue({
        config: { main_branch: "main", release_branch: "release", dev_branch: "dev" },
        errors: [],
      });
      buildCascadePlanMock.mockResolvedValue([{ src: "main", tgt: "release" }]);
      mergeStepMock.mockResolvedValueOnce({
        outcome: "conflict",
        source_sha: "cron-author-sha-1",
        check_run_id: null,
        check_run_html_url: null,
      });
      createConflictPRMock.mockResolvedValue({
        ok: true,
        pr_url: "https://gh/pr/20",
        pr_number: 20,
        reused: false,
      });

      await makeRunCascadeWithNoop()(cronJob());

      const ev = notifyEvents.find((e) => e.kind === "cascade_conflict");
      expect(ev).toBeDefined();
      expect(ev?.kind === "cascade_conflict" && ev.author_login).toBe("alice");
    });

    it("cron path, GitHub user not linked (author null) → no author_login in notify, email flows into createConflictPR", async () => {
      const fakeOctokit = makeCronOctokit("cron-author-sha-2", {
        data: { author: null, commit: { author: { email: "x@y.com" } } },
      });
      getInstallationOctokitMock.mockResolvedValue(fakeOctokit as never);
      loadConfigMock.mockResolvedValue({
        config: { main_branch: "main", release_branch: "release", dev_branch: "dev" },
        errors: [],
      });
      buildCascadePlanMock.mockResolvedValue([{ src: "main", tgt: "release" }]);
      mergeStepMock.mockResolvedValueOnce({
        outcome: "conflict",
        source_sha: "cron-author-sha-2",
        check_run_id: null,
        check_run_html_url: null,
      });
      createConflictPRMock.mockResolvedValue({
        ok: true,
        pr_url: "https://gh/pr/21",
        pr_number: 21,
        reused: false,
      });

      await makeRunCascadeWithNoop()(cronJob());

      const ev = notifyEvents.find((e) => e.kind === "cascade_conflict");
      expect(ev).toBeDefined();
      expect(ev?.kind === "cascade_conflict" && "author_login" in ev).toBe(false);
      const prArg = createConflictPRMock.mock.calls[0]![1];
      expect(prArg.headCommitAuthor.email).toBe("x@y.com");
    });

    it("cron path, commit API throws → fallback author used, cascade continues, warn logged", async () => {
      const fakeOctokit = makeCronOctokit("cron-author-sha-3", null, true);
      getInstallationOctokitMock.mockResolvedValue(fakeOctokit as never);
      loadConfigMock.mockResolvedValue({
        config: { main_branch: "main", release_branch: "release", dev_branch: "dev" },
        errors: [],
      });
      buildCascadePlanMock.mockResolvedValue([{ src: "main", tgt: "release" }]);
      mergeStepMock.mockResolvedValue({ outcome: "merged", sha: "xyz", check_run_id: null });

      await makeRunCascadeWithNoop()(cronJob());

      expect(mergeStepMock).toHaveBeenCalledTimes(1);
      const warnEvents = warnSpy.mock.calls.map(
        (c: unknown[]) => (c[0] as { event?: string })?.event,
      );
      expect(warnEvents).toContain("cascade_failed_author_resolve");
    });

    it("push path → commit author API NOT called (author comes from push payload)", async () => {
      const fakeOctokit = { request: vi.fn() };
      getInstallationOctokitMock.mockResolvedValue(fakeOctokit as never);
      buildCascadePlanMock.mockResolvedValue([]);

      await makeRunCascadeWithNoop()(job());

      const commitApiCalls = fakeOctokit.request.mock.calls.filter(
        (c: unknown[]) => (c[0] as string) === "GET /repos/{owner}/{repo}/commits/{ref}",
      );
      expect(commitApiCalls).toHaveLength(0);
    });
  });
});
