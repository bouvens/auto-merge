import type { Octokit } from "@octokit/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeFailure,
  completeSuccess,
  createFailureCheckRun,
  createInProgress,
  findPriorFailureCheckRun,
} from "../../src/cascade/checkRun.js";
import { log } from "../../src/log.js";

function makeOctokit(impl: (route: string, params: unknown) => unknown): Octokit {
  return { request: vi.fn(impl) } as unknown as Octokit;
}

const baseDeps = (octokit: Octokit) => ({ octokit, owner: "acme", repo: "widgets" });

describe("createInProgress", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs check-run with correct body and returns id/url on success", async () => {
    const requestSpy = vi.fn().mockResolvedValue({
      data: { id: 42, html_url: "https://github.com/acme/widgets/runs/42" },
    });
    const octokit = { request: requestSpy } as unknown as Octokit;

    const result = await createInProgress(baseDeps(octokit), {
      source_sha: "abc1234",
      src: "main",
      tgt: "release",
      runId: "run-uuid-1",
    });

    expect(result).toEqual({
      check_run_id: 42,
      html_url: "https://github.com/acme/widgets/runs/42",
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const [route, body] = requestSpy.mock.calls[0]!;
    expect(route).toBe("POST /repos/{owner}/{repo}/check-runs");
    expect(body).toMatchObject({
      owner: "acme",
      repo: "widgets",
      head_sha: "abc1234",
      name: "auto-merge: main → release",
      status: "in_progress",
      external_id: "run-uuid-1:main:release",
    });
    expect(typeof (body as { started_at: string }).started_at).toBe("string");
  });

  it("returns null and logs on octokit error", async () => {
    const requestSpy = vi.fn().mockRejectedValue(new Error("boom"));
    const octokit = { request: requestSpy } as unknown as Octokit;
    const errSpy = vi.spyOn(log, "error").mockImplementation(() => undefined);

    const result = await createInProgress(baseDeps(octokit), {
      source_sha: "abc1234",
      src: "main",
      tgt: "release",
      runId: "run-uuid-1",
    });

    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [, msg] = errSpy.mock.calls[0]!;
    expect(msg).toBe("check-run-create-failed");
  });
});

describe("completeSuccess", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("PATCHes with conclusion=success and run_id in summary", async () => {
    const requestSpy = vi.fn().mockResolvedValue({ data: {} });
    const octokit = { request: requestSpy } as unknown as Octokit;

    await completeSuccess(baseDeps(octokit), {
      check_run_id: 99,
      src: "main",
      tgt: "release",
      runId: "uuid-X",
    });

    expect(requestSpy).toHaveBeenCalledTimes(1);
    const [route, body] = requestSpy.mock.calls[0]!;
    expect(route).toBe("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}");
    expect(body).toMatchObject({
      owner: "acme",
      repo: "widgets",
      check_run_id: 99,
      status: "completed",
      conclusion: "success",
    });
    const output = (body as { output: { title: string; summary: string } }).output;
    expect(output.title).toBe("Merged main → release");
    expect(output.summary).toContain("uuid-X");
  });

  it("swallows octokit errors", async () => {
    const requestSpy = vi.fn().mockRejectedValue(new Error("nope"));
    const octokit = { request: requestSpy } as unknown as Octokit;
    vi.spyOn(log, "error").mockImplementation(() => undefined);

    await expect(
      completeSuccess(baseDeps(octokit), {
        check_run_id: 1,
        src: "a",
        tgt: "b",
        runId: "r",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("completeFailure", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("real_conflict: summary contains kind, PR URL, run_id", async () => {
    const requestSpy = vi.fn().mockResolvedValue({ data: {} });
    const octokit = { request: requestSpy } as unknown as Octokit;

    await completeFailure(baseDeps(octokit), {
      check_run_id: 7,
      src: "main",
      tgt: "release",
      runId: "r-1",
      kind: "real_conflict",
      detail: "https://github.com/acme/widgets/pull/7",
    });

    const [route, body] = requestSpy.mock.calls[0]!;
    expect(route).toBe("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}");
    const output = (body as { output: { title: string; summary: string } }).output;
    expect(output.title).toBe("Conflict main → release");
    expect(output.summary).toContain("real_conflict");
    expect(output.summary).toContain("https://github.com/acme/widgets/pull/7");
    expect(output.summary).toContain("r-1");
  });

  it("unknown_error with 2000-char detail: summary clamped to ≤ 1024 + small suffix", async () => {
    const requestSpy = vi.fn().mockResolvedValue({ data: {} });
    const octokit = { request: requestSpy } as unknown as Octokit;
    const longDetail = "x".repeat(2000);

    await completeFailure(baseDeps(octokit), {
      check_run_id: 7,
      src: "main",
      tgt: "release",
      runId: "r-2",
      kind: "unknown_error",
      detail: longDetail,
    });

    const [, body] = requestSpy.mock.calls[0]!;
    const summary = (body as { output: { summary: string } }).output.summary;
    expect(summary.length).toBeLessThanOrEqual(1024 + 32);
    expect(summary).toContain("unknown_error");
    expect(summary).toContain("[truncated]");
  });
});

describe("findPriorFailureCheckRun", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when a completed-failure run exists for the given name and head_sha", async () => {
    const requestSpy = vi.fn().mockResolvedValue({
      data: {
        check_runs: [
          { status: "completed", conclusion: "failure" },
          { status: "completed", conclusion: "success" },
        ],
      },
    });
    const octokit = { request: requestSpy } as unknown as Octokit;

    const result = await findPriorFailureCheckRun(baseDeps(octokit), {
      head_sha: "deadbeef",
      name: "auto-merge: main → release",
    });

    expect(result).toBe(true);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const [route, params] = requestSpy.mock.calls[0]!;
    expect(route).toBe("GET /repos/{owner}/{repo}/commits/{ref}/check-runs");
    expect((params as { ref: string }).ref).toBe("deadbeef");
    expect((params as { check_name: string }).check_name).toBe("auto-merge: main → release");
  });

  it("returns false when only an in_progress run exists (our own run must not self-count)", async () => {
    const requestSpy = vi.fn().mockResolvedValue({
      data: { check_runs: [{ status: "in_progress", conclusion: null }] },
    });
    const octokit = { request: requestSpy } as unknown as Octokit;

    const result = await findPriorFailureCheckRun(baseDeps(octokit), {
      head_sha: "abc123",
      name: "auto-merge: main → release",
    });

    expect(result).toBe(false);
  });

  it("returns false (fail-open) when the API call throws, and emits a warn log", async () => {
    const requestSpy = vi.fn().mockRejectedValue(new Error("API timeout"));
    const octokit = { request: requestSpy } as unknown as Octokit;
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const result = await findPriorFailureCheckRun(baseDeps(octokit), {
      head_sha: "abc123",
      name: "auto-merge: main → release",
    });

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, msg] = warnSpy.mock.calls[0]!;
    expect(msg).toBe("find-prior-failure-check-run-failed");
  });

  it("returns false when check_runs is empty", async () => {
    const requestSpy = vi.fn().mockResolvedValue({ data: { check_runs: [] } });
    const octokit = { request: requestSpy } as unknown as Octokit;

    const result = await findPriorFailureCheckRun(baseDeps(octokit), {
      head_sha: "abc123",
      name: "auto-merge: main → dev",
    });

    expect(result).toBe(false);
  });
});

describe("createFailureCheckRun", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs completed/failure with provided head_sha/name/title/summary", async () => {
    const requestSpy = vi.fn().mockResolvedValue({ data: {} });
    const octokit = { request: requestSpy } as unknown as Octokit;

    await createFailureCheckRun(baseDeps(octokit), {
      head_sha: "deadbeef",
      name: "auto-merge / config",
      title: "Invalid .github/auto-merge.yml",
      summary: "- L1:1 — missing main_branch",
    });

    expect(requestSpy).toHaveBeenCalledTimes(1);
    const [route, body] = requestSpy.mock.calls[0]!;
    expect(route).toBe("POST /repos/{owner}/{repo}/check-runs");
    expect(body).toMatchObject({
      owner: "acme",
      repo: "widgets",
      head_sha: "deadbeef",
      name: "auto-merge / config",
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Invalid .github/auto-merge.yml",
        summary: "- L1:1 — missing main_branch",
      },
    });
  });

  it("swallows octokit errors", async () => {
    const requestSpy = vi.fn().mockRejectedValue(new Error("nope"));
    const octokit = { request: requestSpy } as unknown as Octokit;
    vi.spyOn(log, "error").mockImplementation(() => undefined);

    await expect(
      createFailureCheckRun(baseDeps(octokit), {
        head_sha: "x",
        name: "n",
        title: "t",
        summary: "s",
      }),
    ).resolves.toBeUndefined();
  });
});
