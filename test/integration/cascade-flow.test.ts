import { Octokit } from "@octokit/core";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupMswGitHub } from "../helpers/msw-github.js";

vi.mock("../../src/auth.js", () => ({
  getInstallationOctokit: vi.fn(async () => new Octokit({ baseUrl: "https://api.github.com" })),
}));

import type { PushHeadCommit, PushJob } from "../../src/cascade/orchestrator.js";
import { runCascade } from "../../src/cascade/orchestrator.js";
import type { Config } from "../../src/config/schema.js";
import { log } from "../../src/log.js";
import type { Job } from "../../src/webhook/queue.js";

const harness = setupMswGitHub({
  branches: { main: "main-head", release: "release-head", dev: "dev-head" },
});

beforeAll(() => {
  // onUnhandledRequest:"error" surfaces drift between code paths and mocked routes — prevents accidental egress.
  harness.server.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  harness.server.close();
});

beforeEach(() => {
  harness.server.resetHandlers();
  harness.resetCounters();
  harness.state.compare = {
    ahead_by: 1,
    total_commits: 1,
    commits: [{ sha: "aaaaaaa1111111111111111111111111111111aa", commit: { message: "feat: x" } }],
    base_commit: { sha: "tgt-head-before" },
  };
  harness.state.branches = { main: "main-head", release: "release-head", dev: "dev-head" };
  harness.state.mergeStatus = 201;
  harness.state.refExists = false;
  harness.state.openPRs = [];
  harness.state.pullsCreateStatus = 201;
  harness.state.branchHeadAfter = undefined;
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseConfig: Config = {
  main_branch: "main",
  release_branch: "release",
  dev_branch: "dev",
};

function makeHeadCommit(overrides: Partial<PushHeadCommit> = {}): PushHeadCommit {
  return {
    id: "after-sha",
    message: "feat: thing",
    author: { name: "Alice", email: "alice@example.com", username: "alice" },
    ...overrides,
  };
}

function makeJob(overrides: Partial<PushJob> = {}): Job<PushJob> {
  const payload: PushJob = {
    installation_id: 42,
    owner: "acme",
    repo: "widgets",
    branch: "main",
    after: "after-sha-1234567",
    before: "before-sha",
    sender_login: "alice",
    head_commit: makeHeadCommit(overrides.head_commit),
    config: overrides.config ?? baseConfig,
    ...overrides,
  };
  return { id: "delivery-1", payload };
}

describe("cascade-flow integration (msw + real Octokit)", () => {
  it("SC#1 + SC#5: skip first pair (ahead_by=0), merge second pair (ahead_by=2)", async () => {
    let callIdx = 0;
    harness.server.use(
      http.get("https://api.github.com/repos/:owner/:repo/compare/:basehead", ({ request }) => {
        callIdx += 1;
        harness.compareCalls.push({ method: "GET", url: request.url });
        if (callIdx === 1) {
          return HttpResponse.json({
            ahead_by: 0,
            total_commits: 0,
            commits: [],
            base_commit: { sha: "tgt-head" },
          });
        }
        return HttpResponse.json({
          ahead_by: 2,
          total_commits: 2,
          commits: [
            { sha: "c1c1c1c", commit: { message: "feat: a" } },
            { sha: "c2c2c2c", commit: { message: "feat: b" } },
          ],
          base_commit: { sha: "tgt-head-before" },
        });
      }),
    );

    await runCascade(makeJob());

    expect(harness.compareCalls).toHaveLength(2);
    expect(harness.mergeCalls).toHaveLength(1);
    expect(harness.checkRunCreateCalls).toHaveLength(1);
    expect(harness.checkRunPatchCalls).toHaveLength(1);
    expect((harness.checkRunPatchCalls[0]!.body as { conclusion?: string }).conclusion).toBe(
      "success",
    );
  });

  it("SC#2: commit_message contains title, commit summary, and Auto-Merge trailer with UUID", async () => {
    harness.state.compare = {
      ahead_by: 1,
      total_commits: 1,
      commits: [
        { sha: "abc123def4567890abcdef1234567890abcdef12", commit: { message: "feat: thing" } },
      ],
      base_commit: { sha: "tgt-head" },
    };

    await runCascade(makeJob());

    expect(harness.mergeCalls.length).toBeGreaterThanOrEqual(1);
    const body = harness.mergeCalls[0]!.body as { commit_message: string };
    expect(body.commit_message).toContain("Auto-merge main into release");
    expect(body.commit_message).toContain("1 commit abc123d");
    expect(body.commit_message).toContain("(feat: thing)");
    expect(body.commit_message).toMatch(
      /Auto-Merge: cascade [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });

  it("SC#4 stale-base retry: 409 then 201, no conflict PR, Check Run success", async () => {
    let mergeSeq = 0;
    harness.server.use(
      http.post("https://api.github.com/repos/:owner/:repo/merges", async ({ request }) => {
        mergeSeq += 1;
        harness.mergeCalls.push({
          method: "POST",
          url: request.url,
          body: await request.clone().json(),
        });
        if (mergeSeq === 1) {
          return HttpResponse.json({ message: "Merge conflict" }, { status: 409 });
        }
        return HttpResponse.json({ sha: "merge-after-retry" }, { status: 201 });
      }),
      // Target moved between attempts → stale-base, not a real conflict (D-10).
      http.get(
        "https://api.github.com/repos/:owner/:repo/branches/:branch",
        ({ params, request }) => {
          harness.branchCalls.push({ method: "GET", url: request.url });
          return HttpResponse.json({
            name: params.branch as string,
            commit: { sha: mergeSeq >= 1 ? "tgt-head-after" : "tgt-head-before" },
          });
        },
      ),
    );

    await runCascade(makeJob());

    expect(harness.mergeCalls.length).toBeGreaterThanOrEqual(2);
    expect(harness.createRefCalls).toHaveLength(0);
    expect(harness.pullsCreateCalls).toHaveLength(0);
    const successPatch = harness.checkRunPatchCalls.find(
      (c) => (c.body as { conclusion?: string }).conclusion === "success",
    );
    expect(successPatch).toBeDefined();
  });

  it("SC#4 real conflict (createRef 201 + pulls.create 201) — downstream pair NOT merged", async () => {
    harness.state.mergeStatus = 409;
    // base_commit.sha must match the live branch head so the structural before/after check resolves as REAL conflict (D-10).
    harness.state.compare = {
      ahead_by: 1,
      total_commits: 1,
      commits: [{ sha: "abc123def", commit: { message: "feat: x" } }],
      base_commit: { sha: "release-head" },
    };

    await runCascade(makeJob());

    expect(harness.mergeCalls).toHaveLength(1);
    expect(harness.createRefCalls).toHaveLength(1);
    expect(harness.pullsCreateCalls).toHaveLength(1);
    const failurePatch = harness.checkRunPatchCalls.find(
      (c) => (c.body as { conclusion?: string }).conclusion === "failure",
    );
    expect(failurePatch).toBeDefined();
    const summary = (failurePatch!.body as { output?: { summary?: string } }).output?.summary ?? "";
    expect(summary).toContain("https://github.com/owner/repo/pull/");
  });

  it("SC#4 createRef 422 + pulls.list reuses existing PR — no pulls.create, summary references existing PR url", async () => {
    harness.state.mergeStatus = 409;
    harness.state.compare = {
      ahead_by: 1,
      total_commits: 1,
      commits: [{ sha: "abc123def", commit: { message: "feat: x" } }],
      base_commit: { sha: "release-head" },
    };
    harness.state.refExists = true;
    harness.state.openPRs = [
      {
        html_url: "https://github.com/acme/widgets/pull/77",
        number: 77,
        head: { ref: "auto-merge/conflict-main-release-after-s" },
        base: { ref: "release" },
      },
    ];

    await runCascade(makeJob({ after: "after-sha-1234567" }));

    expect(harness.createRefCalls).toHaveLength(1);
    expect(harness.pullsListCalls.length).toBeGreaterThanOrEqual(1);
    expect(harness.pullsCreateCalls).toHaveLength(0);
    const failurePatch = harness.checkRunPatchCalls.find(
      (c) => (c.body as { conclusion?: string }).conclusion === "failure",
    );
    expect(failurePatch).toBeDefined();
    const summary = (failurePatch!.body as { output?: { summary?: string } }).output?.summary ?? "";
    expect(summary).toContain("https://github.com/acme/widgets/pull/77");
  });

  it("CONF-01 cascade stops on first conflict — downstream pair not attempted", async () => {
    harness.state.mergeStatus = 409;
    harness.state.compare = {
      ahead_by: 1,
      total_commits: 1,
      commits: [{ sha: "abc123def", commit: { message: "feat: x" } }],
      base_commit: { sha: "release-head" },
    };

    await runCascade(makeJob());

    expect(harness.compareCalls).toHaveLength(1);
    expect(harness.mergeCalls).toHaveLength(1);
  });

  it("unknown_error 422 on merge — no createRef, no pulls.create, Check Run failure unknown_error", async () => {
    harness.state.mergeStatus = 422;

    await runCascade(makeJob());

    expect(harness.mergeCalls).toHaveLength(1);
    expect(harness.createRefCalls).toHaveLength(0);
    expect(harness.pullsCreateCalls).toHaveLength(0);
    const failurePatch = harness.checkRunPatchCalls.find(
      (c) => (c.body as { conclusion?: string }).conclusion === "failure",
    );
    expect(failurePatch).toBeDefined();
    const summary = (failurePatch!.body as { output?: { summary?: string } }).output?.summary ?? "";
    expect(summary).toContain("unknown_error");
  });

  it("CFG-03 release missing → single-pair cascade main→dev", async () => {
    delete harness.state.branches.release;
    harness.state.compare = {
      ahead_by: 1,
      total_commits: 1,
      commits: [{ sha: "abc123def", commit: { message: "feat: x" } }],
      base_commit: { sha: "dev-head" },
    };

    await runCascade(makeJob());

    expect(harness.compareCalls).toHaveLength(1);
    expect(harness.mergeCalls).toHaveLength(1);
    const body = harness.mergeCalls[0]!.body as { base?: string; head?: string };
    expect(body.base).toBe("dev");
    expect(body.head).toBe("main");
  });
});
