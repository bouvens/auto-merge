import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock all collaborating modules — orchestrator's job is pure dispatch logic, so we isolate it from real Octokit / GitHub API and assert call sequence and Check Run side effects.
vi.mock("../../src/cascade/plan.js", () => ({ buildCascadePlan: vi.fn() }));
vi.mock("../../src/cascade/merge.js", () => ({ mergeStep: vi.fn() }));
vi.mock("../../src/cascade/conflict.js", () => ({ createConflictPR: vi.fn() }));
vi.mock("../../src/cascade/checkRun.js", () => ({ completeFailure: vi.fn() }));
vi.mock("../../src/auth.js", () => ({
  getInstallationOctokit: vi.fn(async () => ({ request: vi.fn() })),
}));

import { getInstallationOctokit } from "../../src/auth.js";
import { completeFailure } from "../../src/cascade/checkRun.js";
import { createConflictPR } from "../../src/cascade/conflict.js";
import { log } from "../../src/log.js";
import { mergeStep } from "../../src/cascade/merge.js";
import { runCascade, type PushJob } from "../../src/cascade/orchestrator.js";
import { buildCascadePlan } from "../../src/cascade/plan.js";

const mergeStepMock = vi.mocked(mergeStep);
const buildCascadePlanMock = vi.mocked(buildCascadePlan);
const createConflictPRMock = vi.mocked(createConflictPR);
const completeFailureMock = vi.mocked(completeFailure);
const getInstallationOctokitMock = vi.mocked(getInstallationOctokit);

const job = (overrides: Partial<PushJob> = {}) => ({
  id: "delivery-xyz",
  payload: {
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

let infoSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  getInstallationOctokitMock.mockResolvedValue({ request: vi.fn() } as never);
  infoSpy = vi.spyOn(log, "info").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined);
});

describe("runCascade", () => {
  it("two-pair plan, both merged → both pairs visited, no completeFailure, no createConflictPR", async () => {
    buildCascadePlanMock.mockResolvedValue([
      { src: "main", tgt: "release" },
      { src: "release", tgt: "dev" },
    ]);
    mergeStepMock.mockResolvedValue({ outcome: "merged", sha: "abc", check_run_id: 1 });

    await runCascade(job());

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

    await runCascade(job());

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

    await runCascade(job({ branch: "main" }));

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

    await runCascade(job());

    expect(completeFailureMock).toHaveBeenCalledTimes(1);
    const failArg = completeFailureMock.mock.calls[0]![1];
    expect(failArg.kind).toBe("real_conflict");
    expect(failArg.detail).toContain("conflict PR failed");
    expect(failArg.detail).toContain("createRef 500");
  });

  it("buildCascadePlan throws → cascade_failed logged, mergeStep NOT called", async () => {
    buildCascadePlanMock.mockRejectedValue(new Error("getBranch 503"));

    await runCascade(job());

    expect(mergeStepMock).not.toHaveBeenCalled();
    expect(completeFailureMock).not.toHaveBeenCalled();
    const errorEvents = errorSpy.mock.calls
      .map((c) => (c[0] as { event?: string })?.event)
      .filter(Boolean);
    expect(errorEvents).toContain("cascade_failed");
  });

  it("synthetic error inside loop → cascade_failed logged, no rethrow", async () => {
    buildCascadePlanMock.mockResolvedValue([{ src: "main", tgt: "dev" }]);
    mergeStepMock.mockImplementationOnce(async () => {
      throw new Error("network drop");
    });

    await expect(runCascade(job())).resolves.toBeUndefined();
    const errorEvents = errorSpy.mock.calls
      .map((c) => (c[0] as { event?: string })?.event)
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

    await runCascade(job());

    expect(mergeStepMock).toHaveBeenCalledTimes(2);
    expect(completeFailureMock).not.toHaveBeenCalled();
  });

  it("runId is a valid UUID v4 string in cascade_started log", async () => {
    buildCascadePlanMock.mockResolvedValue([]);

    await runCascade(job());

    const started = infoSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === "cascade_started",
    );
    expect(started).toBeDefined();
    const runId = (started![0] as { run_id: string }).run_id;
    expect(runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
