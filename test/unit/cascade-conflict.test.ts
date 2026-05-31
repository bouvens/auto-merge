import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConflictPR } from "../../src/cascade/conflict.js";

type Response =
  | { status: number; data?: unknown }
  | { __throw: { status?: number; message?: string } };

interface MockSpec {
  [route: string]: Response[];
}

function makeOctokit(spec: MockSpec) {
  const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
  const cursors: Record<string, number> = {};
  const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
    calls.push({ route, params });
    const queue = spec[route];
    if (!queue || queue.length === 0) {
      throw new Error(`unexpected route call: ${route}`);
    }
    const idx = cursors[route] ?? 0;
    const resp = queue[Math.min(idx, queue.length - 1)]!;
    cursors[route] = idx + 1;
    if ("__throw" in resp) {
      const err = new Error(resp.__throw.message ?? "mock error") as Error & { status?: number };
      if (resp.__throw.status !== undefined) err.status = resp.__throw.status;
      throw err;
    }
    return { status: resp.status, data: resp.data, headers: {}, url: route };
  });
  return { request, calls };
}

const baseOpts = {
  src: "main",
  tgt: "release",
  source_sha: "abcdef1234567890aaaaaaaaaaaaaaaaaaaaaaaa",
  runId: "11111111-2222-3333-4444-555555555555",
  checkRunHtmlUrl: "https://github.com/o/r/runs/42",
  headCommitAuthor: { username: "alice", email: "alice@example.com" },
};

const baseDeps = (octokit: ReturnType<typeof makeOctokit>) => ({
  octokit: octokit as unknown as Parameters<typeof createConflictPR>[0]["octokit"],
  owner: "o",
  repo: "r",
});

describe("createConflictPR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: createRef 201 + username → creates new PR with @mention, run_id, Check Run URL", async () => {
    const oc = makeOctokit({
      "POST /repos/{owner}/{repo}/git/refs": [{ status: 201, data: {} }],
      "POST /repos/{owner}/{repo}/pulls": [
        { status: 201, data: { html_url: "https://github.com/o/r/pull/7", number: 7 } },
      ],
    });
    const res = await createConflictPR(baseDeps(oc), baseOpts);
    expect(res).toEqual({
      ok: true,
      pr_url: "https://github.com/o/r/pull/7",
      pr_number: 7,
      reused: false,
    });
    const createCall = oc.calls.find((c) => c.route === "POST /repos/{owner}/{repo}/pulls")!;
    const body = createCall.params.body as string;
    expect(body).toContain("@alice");
    expect(body).toContain("run_id: 11111111-2222-3333-4444-555555555555");
    expect(body).toContain("Check Run: https://github.com/o/r/runs/42");
    expect(createCall.params.title).toBe("Auto-merge conflict: main → release");
    expect(createCall.params.head).toBe("auto-merge/conflict-main-release");
    expect(createCall.params.base).toBe("release");
  });

  it("createRef 422 + open PR exists → reused=true, pulls.create NOT called", async () => {
    const oc = makeOctokit({
      "POST /repos/{owner}/{repo}/git/refs": [{ __throw: { status: 422 } }],
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}": [{ status: 200, data: {} }],
      "GET /repos/{owner}/{repo}/pulls": [
        {
          status: 200,
          data: [{ html_url: "https://github.com/o/r/pull/3", number: 3 }],
        },
      ],
    });
    const res = await createConflictPR(baseDeps(oc), baseOpts);
    expect(res).toEqual({
      ok: true,
      pr_url: "https://github.com/o/r/pull/3",
      pr_number: 3,
      reused: true,
    });
    expect(oc.calls.some((c) => c.route === "POST /repos/{owner}/{repo}/pulls")).toBe(false);
    const listCall = oc.calls.find((c) => c.route === "GET /repos/{owner}/{repo}/pulls")!;
    expect(listCall.params.head).toBe("o:auto-merge/conflict-main-release");
    expect(listCall.params.state).toBe("open");
  });

  it("createRef 422 + no open PR → creates new PR on same ref, reused=false", async () => {
    const oc = makeOctokit({
      "POST /repos/{owner}/{repo}/git/refs": [{ __throw: { status: 422 } }],
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}": [{ status: 200, data: {} }],
      "GET /repos/{owner}/{repo}/pulls": [{ status: 200, data: [] }],
      "POST /repos/{owner}/{repo}/pulls": [
        { status: 201, data: { html_url: "https://github.com/o/r/pull/9", number: 9 } },
      ],
    });
    const res = await createConflictPR(baseDeps(oc), baseOpts);
    expect(res).toEqual({
      ok: true,
      pr_url: "https://github.com/o/r/pull/9",
      pr_number: 9,
      reused: false,
    });
  });

  it("author resolution: username=null → getCommit login → @bob in body", async () => {
    const oc = makeOctokit({
      "POST /repos/{owner}/{repo}/git/refs": [{ status: 201, data: {} }],
      "GET /repos/{owner}/{repo}/commits/{ref}": [
        { status: 200, data: { author: { login: "bob" } } },
      ],
      "POST /repos/{owner}/{repo}/pulls": [{ status: 201, data: { html_url: "u", number: 1 } }],
    });
    const res = await createConflictPR(baseDeps(oc), {
      ...baseOpts,
      headCommitAuthor: { username: null, email: "alice@example.com" },
    });
    expect(res.ok).toBe(true);
    const body = oc.calls.find((c) => c.route === "POST /repos/{owner}/{repo}/pulls")!.params
      .body as string;
    expect(body).toContain("@bob");
  });

  it("author resolution: username=null + getCommit throws → email fallback (no @)", async () => {
    const oc = makeOctokit({
      "POST /repos/{owner}/{repo}/git/refs": [{ status: 201, data: {} }],
      "GET /repos/{owner}/{repo}/commits/{ref}": [{ __throw: { status: 500 } }],
      "POST /repos/{owner}/{repo}/pulls": [{ status: 201, data: { html_url: "u", number: 1 } }],
    });
    const res = await createConflictPR(baseDeps(oc), {
      ...baseOpts,
      headCommitAuthor: { username: null, email: "alice@example.com" },
    });
    expect(res.ok).toBe(true);
    const body = oc.calls.find((c) => c.route === "POST /repos/{owner}/{repo}/pulls")!.params
      .body as string;
    expect(body).toContain("(author email: alice@example.com)");
    expect(body).not.toContain("@alice@example.com");
  });

  it("author resolution: getCommit returns author=null → email fallback", async () => {
    const oc = makeOctokit({
      "POST /repos/{owner}/{repo}/git/refs": [{ status: 201, data: {} }],
      "GET /repos/{owner}/{repo}/commits/{ref}": [{ status: 200, data: { author: null } }],
      "POST /repos/{owner}/{repo}/pulls": [{ status: 201, data: { html_url: "u", number: 1 } }],
    });
    await createConflictPR(baseDeps(oc), {
      ...baseOpts,
      headCommitAuthor: { username: null, email: "carol@example.com" },
    });
    const body = oc.calls.find((c) => c.route === "POST /repos/{owner}/{repo}/pulls")!.params
      .body as string;
    expect(body).toContain("(author email: carol@example.com)");
  });

  it("checkRunHtmlUrl=null → body shows '(not available)'", async () => {
    const oc = makeOctokit({
      "POST /repos/{owner}/{repo}/git/refs": [{ status: 201, data: {} }],
      "POST /repos/{owner}/{repo}/pulls": [{ status: 201, data: { html_url: "u", number: 1 } }],
    });
    await createConflictPR(baseDeps(oc), { ...baseOpts, checkRunHtmlUrl: null });
    const body = oc.calls.find((c) => c.route === "POST /repos/{owner}/{repo}/pulls")!.params
      .body as string;
    expect(body).toContain("Check Run: (not available)");
  });

  it("createRef 500 → returns {ok:false}", async () => {
    const oc = makeOctokit({
      "POST /repos/{owner}/{repo}/git/refs": [{ __throw: { status: 500, message: "boom" } }],
    });
    const res = await createConflictPR(baseDeps(oc), baseOpts);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("createRef");
    }
  });

  it("pulls.create 422 race → pulls.list retried → reused=true", async () => {
    const oc = makeOctokit({
      "POST /repos/{owner}/{repo}/git/refs": [{ status: 201, data: {} }],
      "POST /repos/{owner}/{repo}/pulls": [{ __throw: { status: 422 } }],
      "GET /repos/{owner}/{repo}/pulls": [
        { status: 200, data: [{ html_url: "https://github.com/o/r/pull/5", number: 5 }] },
      ],
    });
    const res = await createConflictPR(baseDeps(oc), baseOpts);
    expect(res).toEqual({
      ok: true,
      pr_url: "https://github.com/o/r/pull/5",
      pr_number: 5,
      reused: true,
    });
  });

  it("pulls.create 422 race → pulls.list still empty → {ok:false}", async () => {
    const oc = makeOctokit({
      "POST /repos/{owner}/{repo}/git/refs": [{ status: 201, data: {} }],
      "POST /repos/{owner}/{repo}/pulls": [{ __throw: { status: 422 } }],
      "GET /repos/{owner}/{repo}/pulls": [{ status: 200, data: [] }],
    });
    const res = await createConflictPR(baseDeps(oc), baseOpts);
    expect(res.ok).toBe(false);
  });

  it("summaryPrefix provided → PR body starts with prefix line before conflict text", async () => {
    const oc = makeOctokit({
      "POST /repos/{owner}/{repo}/git/refs": [{ status: 201, data: {} }],
      "POST /repos/{owner}/{repo}/pulls": [
        { status: 201, data: { html_url: "https://github.com/o/r/pull/8", number: 8 } },
      ],
    });
    const res = await createConflictPR(baseDeps(oc), {
      ...baseOpts,
      summaryPrefix: "Blocked by branch protection: required_pull_request_reviews",
    });
    expect(res.ok).toBe(true);
    const body = oc.calls.find((c) => c.route === "POST /repos/{owner}/{repo}/pulls")!.params
      .body as string;
    expect(body.startsWith("Blocked by branch protection: required_pull_request_reviews")).toBe(
      true,
    );
    expect(body).toContain("Auto-merge");
  });

  it("summaryPrefix absent → PR body unchanged (no extra prefix line)", async () => {
    const oc = makeOctokit({
      "POST /repos/{owner}/{repo}/git/refs": [{ status: 201, data: {} }],
      "POST /repos/{owner}/{repo}/pulls": [
        { status: 201, data: { html_url: "https://github.com/o/r/pull/9", number: 9 } },
      ],
    });
    await createConflictPR(baseDeps(oc), baseOpts);
    const body = oc.calls.find((c) => c.route === "POST /repos/{owner}/{repo}/pulls")!.params
      .body as string;
    expect(body.startsWith("Auto-merge")).toBe(true);
  });
});
