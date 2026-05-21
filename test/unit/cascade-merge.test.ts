import type { Octokit } from "@octokit/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as checkRunModule from "../../src/cascade/checkRun.js";
import * as protectionCheckModule from "../../src/cascade/protectionCheck.js";
import { mergeStep } from "../../src/cascade/merge.js";
import { log } from "../../src/log.js";

// Stub protectionCheck so existing tests' request mocks don't need to handle the protection endpoint.
vi.mock("../../src/cascade/protectionCheck.js", async (importOriginal) => {
  const original = await importOriginal<typeof protectionCheckModule>();
  return { ...original, protectionCheck: vi.fn(async () => ({ blocked: false })) };
});

// Single-page compare fixture — tests override only ahead_by / base_commit.sha.
function compareData(opts: {
  ahead_by: number;
  total_commits?: number;
  base_commit_sha?: string;
}): unknown {
  const total = opts.total_commits ?? opts.ahead_by;
  return {
    ahead_by: opts.ahead_by,
    behind_by: 0,
    total_commits: total,
    base_commit: { sha: opts.base_commit_sha ?? "tgthead000" },
    commits: Array.from({ length: total }, (_, i) => ({
      sha: `cccc${i}00`,
      commit: { message: `commit ${i}` },
    })),
  };
}

const baseDeps = (octokit: Octokit) => ({
  octokit,
  owner: "acme",
  repo: "widgets",
  appSlug: "my-app",
});
const baseOpts = {
  src: "main",
  tgt: "release",
  source_sha: "src1234",
  runId: "run-uuid-1",
  deliveryId: "delivery-1",
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});

describe("mergeStep", () => {
  it("ahead_by=0 → returns skipped/ahead_by_zero, no Check Run, only compare called", async () => {
    const request = vi.fn(async (route: string) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/compare/")) {
        return { data: compareData({ ahead_by: 0, total_commits: 0 }), status: 200 };
      }
      throw new Error(`unexpected route ${route}`);
    });
    const octokit = { request } as unknown as Octokit;
    const createSpy = vi.spyOn(checkRunModule, "createInProgress");

    const result = await mergeStep(baseDeps(octokit), baseOpts);

    expect(result).toEqual({ outcome: "skipped", reason: "ahead_by_zero" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("ahead_by=3, merge 201 → returns merged with sha; createInProgress + completeSuccess called", async () => {
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/compare/")) {
        return { data: compareData({ ahead_by: 3 }), status: 200 };
      }
      if (route === "POST /repos/{owner}/{repo}/merges") {
        const msg = params.commit_message as string;
        expect(msg).toContain("Auto-merge main into release");
        expect(msg).toContain("Auto-Merge: cascade run-uuid-1");
        return { data: { sha: "merge-sha-1" }, status: 201 };
      }
      throw new Error(`unexpected route ${route}`);
    });
    const octokit = { request } as unknown as Octokit;
    const createSpy = vi
      .spyOn(checkRunModule, "createInProgress")
      .mockResolvedValue({ check_run_id: 42, html_url: "https://gh/cr/42" });
    const completeSpy = vi.spyOn(checkRunModule, "completeSuccess").mockResolvedValue(undefined);

    const result = await mergeStep(baseDeps(octokit), baseOpts);

    expect(result).toEqual({ outcome: "merged", sha: "merge-sha-1", check_run_id: 42 });
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledTimes(1);
    const mergeCalls = request.mock.calls.filter(
      ([r]) => r === "POST /repos/{owner}/{repo}/merges",
    );
    expect(mergeCalls).toHaveLength(1);
  });

  it("ahead_by=3, merge 204 → returns skipped/status_204; PATCH check_run with conclusion=neutral; no completeSuccess", async () => {
    const patchCalls: Array<Record<string, unknown>> = [];
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/compare/")) {
        return { data: compareData({ ahead_by: 3 }), status: 200 };
      }
      if (route === "POST /repos/{owner}/{repo}/merges") {
        return { data: undefined, status: 204 };
      }
      if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
        patchCalls.push(params);
        return { data: {}, status: 200 };
      }
      throw new Error(`unexpected route ${route}`);
    });
    const octokit = { request } as unknown as Octokit;
    vi.spyOn(checkRunModule, "createInProgress").mockResolvedValue({
      check_run_id: 77,
      html_url: "https://gh/cr/77",
    });
    const completeSpy = vi.spyOn(checkRunModule, "completeSuccess");

    const result = await mergeStep(baseDeps(octokit), baseOpts);

    expect(result).toEqual({ outcome: "skipped", reason: "status_204" });
    expect(completeSpy).not.toHaveBeenCalled();
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toMatchObject({
      check_run_id: 77,
      status: "completed",
      conclusion: "neutral",
    });
  });

  it("ahead_by=3, 409 with before===after (real conflict) → returns conflict; no retry, no completeSuccess", async () => {
    const mergeCalls: number[] = [];
    const request = vi.fn(async (route: string) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/compare/")) {
        return {
          data: compareData({ ahead_by: 3, base_commit_sha: "before-sha" }),
          status: 200,
        };
      }
      if (route === "POST /repos/{owner}/{repo}/merges") {
        mergeCalls.push(1);
        const err = new Error("conflict") as Error & { status: number };
        err.status = 409;
        throw err;
      }
      if (route === "GET /repos/{owner}/{repo}/branches/{branch}") {
        return { data: { commit: { sha: "before-sha" } }, status: 200 };
      }
      throw new Error(`unexpected route ${route}`);
    });
    const octokit = { request } as unknown as Octokit;
    vi.spyOn(checkRunModule, "createInProgress").mockResolvedValue({
      check_run_id: 5,
      html_url: "https://gh/cr/5",
    });
    const completeSpy = vi.spyOn(checkRunModule, "completeSuccess");

    const result = await mergeStep(baseDeps(octokit), baseOpts);

    expect(result).toEqual({
      outcome: "conflict",
      source_sha: "src1234",
      check_run_id: 5,
      check_run_html_url: "https://gh/cr/5",
    });
    expect(mergeCalls).toHaveLength(1);
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("ahead_by=3, 409 with before!==after, retry 201 → merged; merge called twice; completeSuccess called", async () => {
    let mergeAttempt = 0;
    const request = vi.fn(async (route: string) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/compare/")) {
        return {
          data: compareData({ ahead_by: 3, base_commit_sha: "before-sha" }),
          status: 200,
        };
      }
      if (route === "POST /repos/{owner}/{repo}/merges") {
        mergeAttempt += 1;
        if (mergeAttempt === 1) {
          const err = new Error("conflict") as Error & { status: number };
          err.status = 409;
          throw err;
        }
        return { data: { sha: "retry-sha" }, status: 201 };
      }
      if (route === "GET /repos/{owner}/{repo}/branches/{branch}") {
        return { data: { commit: { sha: "after-sha" } }, status: 200 };
      }
      throw new Error(`unexpected route ${route}`);
    });
    const octokit = { request } as unknown as Octokit;
    vi.spyOn(checkRunModule, "createInProgress").mockResolvedValue({
      check_run_id: 11,
      html_url: "https://gh/cr/11",
    });
    const completeSpy = vi.spyOn(checkRunModule, "completeSuccess").mockResolvedValue(undefined);

    const result = await mergeStep(baseDeps(octokit), baseOpts);

    expect(result).toEqual({ outcome: "merged", sha: "retry-sha", check_run_id: 11 });
    expect(mergeAttempt).toBe(2);
    expect(completeSpy).toHaveBeenCalledTimes(1);
  });

  it("ahead_by=3, 409 with before!==after, retry 409 → returns conflict; merge called exactly twice", async () => {
    let mergeAttempt = 0;
    const request = vi.fn(async (route: string) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/compare/")) {
        return {
          data: compareData({ ahead_by: 3, base_commit_sha: "before-sha" }),
          status: 200,
        };
      }
      if (route === "POST /repos/{owner}/{repo}/merges") {
        mergeAttempt += 1;
        const err = new Error("conflict") as Error & { status: number };
        err.status = 409;
        throw err;
      }
      if (route === "GET /repos/{owner}/{repo}/branches/{branch}") {
        return { data: { commit: { sha: "after-sha" } }, status: 200 };
      }
      throw new Error(`unexpected route ${route}`);
    });
    const octokit = { request } as unknown as Octokit;
    vi.spyOn(checkRunModule, "createInProgress").mockResolvedValue({
      check_run_id: 13,
      html_url: "https://gh/cr/13",
    });
    const completeSpy = vi.spyOn(checkRunModule, "completeSuccess");

    const result = await mergeStep(baseDeps(octokit), baseOpts);

    expect(result).toEqual({
      outcome: "conflict",
      source_sha: "src1234",
      check_run_id: 13,
      check_run_html_url: "https://gh/cr/13",
    });
    expect(mergeAttempt).toBe(2);
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("ahead_by=3, 422 → returns unknown_error with status=422", async () => {
    const request = vi.fn(async (route: string) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/compare/")) {
        return { data: compareData({ ahead_by: 3 }), status: 200 };
      }
      if (route === "POST /repos/{owner}/{repo}/merges") {
        const err = new Error("validation failed") as Error & {
          status: number;
          response: { data: { message: string } };
        };
        err.status = 422;
        err.response = { data: { message: "spam detected" } };
        throw err;
      }
      throw new Error(`unexpected route ${route}`);
    });
    const octokit = { request } as unknown as Octokit;
    vi.spyOn(checkRunModule, "createInProgress").mockResolvedValue({
      check_run_id: 21,
      html_url: "https://gh/cr/21",
    });

    const result = await mergeStep(baseDeps(octokit), baseOpts);

    expect(result).toMatchObject({
      outcome: "unknown_error",
      status: 422,
      check_run_id: 21,
    });
    if (result.outcome === "unknown_error") {
      expect(result.message).toBe("spam detected");
    }
  });

  it("ahead_by=3, non-RequestError network failure → returns unknown_error with message", async () => {
    const request = vi.fn(async (route: string) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/compare/")) {
        return { data: compareData({ ahead_by: 3 }), status: 200 };
      }
      if (route === "POST /repos/{owner}/{repo}/merges") {
        throw new Error("ECONNRESET");
      }
      throw new Error(`unexpected route ${route}`);
    });
    const octokit = { request } as unknown as Octokit;
    vi.spyOn(checkRunModule, "createInProgress").mockResolvedValue({
      check_run_id: 31,
      html_url: "https://gh/cr/31",
    });

    const result = await mergeStep(baseDeps(octokit), baseOpts);

    expect(result.outcome).toBe("unknown_error");
    if (result.outcome === "unknown_error") {
      expect(result.message).toBe("ECONNRESET");
      expect(result.status).toBeUndefined();
      expect(result.check_run_id).toBe(31);
    }
  });

  it("createInProgress returns null → merge still attempted; success returns merged with check_run_id=null", async () => {
    const request = vi.fn(async (route: string) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/compare/")) {
        return { data: compareData({ ahead_by: 1 }), status: 200 };
      }
      if (route === "POST /repos/{owner}/{repo}/merges") {
        return { data: { sha: "ok-sha" }, status: 201 };
      }
      throw new Error(`unexpected route ${route}`);
    });
    const octokit = { request } as unknown as Octokit;
    vi.spyOn(checkRunModule, "createInProgress").mockResolvedValue(null);
    const completeSpy = vi.spyOn(checkRunModule, "completeSuccess");

    const result = await mergeStep(baseDeps(octokit), baseOpts);

    expect(result).toEqual({ outcome: "merged", sha: "ok-sha", check_run_id: null });
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("protection_blocked → returns protection_blocked outcome, no merge attempt, no Check Run in_progress", async () => {
    const request = vi.fn(async (route: string) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/compare/")) {
        return { data: compareData({ ahead_by: 1 }), status: 200 };
      }
      throw new Error(`unexpected route ${route}`);
    });
    const octokit = { request } as unknown as Octokit;
    vi.spyOn(protectionCheckModule, "protectionCheck").mockResolvedValue({
      blocked: true,
      rules: ["required_pull_request_reviews"],
    });
    const createInProgressSpy = vi.spyOn(checkRunModule, "createInProgress");

    const result = await mergeStep(baseDeps(octokit), baseOpts);

    expect(result).toMatchObject({
      outcome: "protection_blocked",
      rule: "required_pull_request_reviews",
      source_sha: "src1234",
      check_run_id: null,
      check_run_html_url: null,
    });
    // protection_blocked must skip merge attempt and in_progress Check Run
    expect(createInProgressSpy).not.toHaveBeenCalled();
    const mergeCalls = request.mock.calls.filter(([r]) => r === "POST /repos/{owner}/{repo}/merges");
    expect(mergeCalls).toHaveLength(0);
  });

  it("protection 403 (permission_error) → createFailureCheckRun called, no merge attempt", async () => {
    const request = vi.fn(async (route: string) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/compare/")) {
        return { data: compareData({ ahead_by: 1 }), status: 200 };
      }
      throw new Error(`unexpected route ${route}`);
    });
    const octokit = { request } as unknown as Octokit;
    vi.spyOn(protectionCheckModule, "protectionCheck").mockResolvedValue({
      permission_error: true,
      status: 403,
    });
    const createFailureSpy = vi
      .spyOn(checkRunModule, "createFailureCheckRun")
      .mockResolvedValue(undefined);
    const createInProgressSpy = vi.spyOn(checkRunModule, "createInProgress");

    const result = await mergeStep(baseDeps(octokit), baseOpts);

    expect(result).toMatchObject({
      outcome: "permission_error",
      endpoint: "branches_protection",
      status: 403,
      missing_permission: "administration:read",
    });
    expect(createFailureSpy).toHaveBeenCalledTimes(1);
    expect(createInProgressSpy).not.toHaveBeenCalled();
  });

  it("compare 403 → permission_error outcome with endpoint=compare", async () => {
    const request = vi.fn(async (route: string) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/compare/")) {
        const err = new Error("forbidden") as Error & { status: number };
        err.status = 403;
        throw err;
      }
      throw new Error(`unexpected route ${route}`);
    });
    const octokit = { request } as unknown as Octokit;

    const result = await mergeStep(baseDeps(octokit), baseOpts);

    expect(result).toMatchObject({
      outcome: "permission_error",
      endpoint: "compare",
      status: 403,
      missing_permission: "contents:read",
      check_run_id: null,
    });
  });

  it("merges 403 → permission_error outcome with endpoint=merges, check_run_id preserved", async () => {
    const request = vi.fn(async (route: string) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/compare/")) {
        return { data: compareData({ ahead_by: 1 }), status: 200 };
      }
      if (route === "POST /repos/{owner}/{repo}/merges") {
        const err = new Error("forbidden") as Error & { status: number };
        err.status = 403;
        throw err;
      }
      throw new Error(`unexpected route ${route}`);
    });
    const octokit = { request } as unknown as Octokit;
    vi.spyOn(protectionCheckModule, "protectionCheck").mockResolvedValue({ blocked: false });
    vi.spyOn(checkRunModule, "createInProgress").mockResolvedValue({
      check_run_id: 55,
      html_url: "https://gh/cr/55",
    });

    const result = await mergeStep(baseDeps(octokit), baseOpts);

    expect(result).toMatchObject({
      outcome: "permission_error",
      endpoint: "merges",
      status: 403,
      missing_permission: "contents:write",
      check_run_id: 55,
    });
  });
});
