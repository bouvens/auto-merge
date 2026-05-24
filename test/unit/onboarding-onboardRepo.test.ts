import { beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../../src/log.js";
import { onboardRepo } from "../../src/onboarding/onboardRepo.js";

type Handler = (params: Record<string, unknown>) => unknown;

function httpError(status: number, message = "err"): Error {
  return Object.assign(new Error(message), { status });
}

function makeMockOctokit(routes: Record<string, Handler | Handler[]>) {
  const cursors: Record<string, number> = {};
  const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
    const entry = routes[route];
    if (entry === undefined) {
      throw httpError(500, `unmocked: ${route}`);
    }
    const handler = Array.isArray(entry) ? entry[cursors[route] ?? 0] : entry;
    if (Array.isArray(entry)) cursors[route] = (cursors[route] ?? 0) + 1;
    const result = (handler as Handler)(params);
    if (result instanceof Error) throw result;
    return { data: result, status: 200 };
  });
  return { request } as unknown as Parameters<typeof onboardRepo>[0]["octokitFactory"] extends (
    id: number,
  ) => Promise<infer O | undefined>
    ? O
    : never;
}

const baseArgs = {
  installationId: 555,
  owner: "acme",
  repo: "widgets",
  senderLogin: "octocat",
  publicUrl: "https://am.example.com",
};

const HAPPY_HEAD = { ref: "auto-merge/onboarding" };

describe("onboarding/onboardRepo — all branches", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("token_mint_failed: factory returns undefined, no API calls", async () => {
    const factory = vi.fn(async () => undefined);
    const outcome = await onboardRepo({ ...baseArgs, octokitFactory: factory });
    expect(outcome).toEqual({ status: "token_mint_failed", owner: "acme", repo: "widgets" });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("happy path with defaultBranchHint: skip GET /repos, create PR", async () => {
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}/contents/{path}": () => httpError(404),
      "GET /repos/{owner}/{repo}/pulls": () => [],
      "GET /repos/{owner}/{repo}/git/ref/heads/{branch}": () => ({ object: { sha: "abc123" } }),
      "POST /repos/{owner}/{repo}/git/refs": () => ({ ref: "refs/heads/auto-merge/onboarding" }),
      "PUT /repos/{owner}/{repo}/contents/{path}": () => ({ commit: { sha: "c1" } }),
      "POST /repos/{owner}/{repo}/pulls": () => ({
        number: 42,
        html_url: "https://github.com/acme/widgets/pull/42",
      }),
    });
    const outcome = await onboardRepo({
      ...baseArgs,
      defaultBranchHint: "main",
      octokitFactory: async () => mock,
    });
    expect(outcome).toEqual({
      status: "created",
      owner: "acme",
      repo: "widgets",
      pr_number: 42,
      pr_url: "https://github.com/acme/widgets/pull/42",
    });
    const calls = (mock as { request: { mock: { calls: unknown[][] } } }).request.mock.calls.map(
      (c) => c[0],
    );
    expect(calls).not.toContain("GET /repos/{owner}/{repo}");
  });

  it("happy path without hint: GET /repos returns default_branch=main", async () => {
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}": () => ({ default_branch: "main" }),
      "GET /repos/{owner}/{repo}/contents/{path}": () => httpError(404),
      "GET /repos/{owner}/{repo}/pulls": () => [],
      "GET /repos/{owner}/{repo}/git/ref/heads/{branch}": () => ({ object: { sha: "abc" } }),
      "POST /repos/{owner}/{repo}/git/refs": () => ({}),
      "PUT /repos/{owner}/{repo}/contents/{path}": () => ({}),
      "POST /repos/{owner}/{repo}/pulls": () => ({ number: 7, html_url: "https://x/7" }),
    });
    const outcome = await onboardRepo({ ...baseArgs, octokitFactory: async () => mock });
    expect(outcome.status).toBe("created");
  });

  it("GET /repos returns no default_branch → fallback 'main'", async () => {
    const captured: Record<string, unknown>[] = [];
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}": () => ({}),
      "GET /repos/{owner}/{repo}/contents/{path}": (p) => {
        captured.push(p);
        return httpError(404);
      },
      "GET /repos/{owner}/{repo}/pulls": () => [],
      "GET /repos/{owner}/{repo}/git/ref/heads/{branch}": (p) => {
        captured.push(p);
        return { object: { sha: "abc" } };
      },
      "POST /repos/{owner}/{repo}/git/refs": () => ({}),
      "PUT /repos/{owner}/{repo}/contents/{path}": () => ({}),
      "POST /repos/{owner}/{repo}/pulls": () => ({ number: 1, html_url: "u" }),
    });
    const outcome = await onboardRepo({ ...baseArgs, octokitFactory: async () => mock });
    expect(outcome.status).toBe("created");
    expect(captured[0]?.ref).toBe("main");
  });

  it("idempotency A: config exists → skipped/config_exists", async () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => log);
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}/contents/{path}": () => ({ sha: "abc", content: "" }),
    });
    const outcome = await onboardRepo({
      ...baseArgs,
      defaultBranchHint: "main",
      octokitFactory: async () => mock,
    });
    expect(outcome).toEqual({
      status: "skipped",
      owner: "acme",
      repo: "widgets",
      reason: "config_exists",
    });
    expect((mock as { request: { mock: { calls: unknown[][] } } }).request.mock.calls).toHaveLength(
      1,
    );
    expect(infoSpy.mock.calls[0]?.[0]).toMatchObject({ event: "onboard_skipped_config_exists" });
  });

  it("idempotency B: open onboarding PR → skipped/pr_open", async () => {
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}/contents/{path}": () => httpError(404),
      "GET /repos/{owner}/{repo}/pulls": () => [
        { number: 9, state: "open", merged_at: null, html_url: "u", head: HAPPY_HEAD },
      ],
    });
    const outcome = await onboardRepo({
      ...baseArgs,
      defaultBranchHint: "main",
      octokitFactory: async () => mock,
    });
    expect(outcome).toEqual({
      status: "skipped",
      owner: "acme",
      repo: "widgets",
      reason: "pr_open",
    });
  });

  it("idempotency B: closed-no-merge PR → skipped/pr_declined", async () => {
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}/contents/{path}": () => httpError(404),
      "GET /repos/{owner}/{repo}/pulls": () => [
        { number: 9, state: "closed", merged_at: null, html_url: "u", head: HAPPY_HEAD },
      ],
    });
    const outcome = await onboardRepo({
      ...baseArgs,
      defaultBranchHint: "main",
      octokitFactory: async () => mock,
    });
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") expect(outcome.reason).toBe("pr_declined");
  });

  it("idempotency B: merged PR also → skipped/pr_declined (any closed)", async () => {
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}/contents/{path}": () => httpError(404),
      "GET /repos/{owner}/{repo}/pulls": () => [
        {
          number: 9,
          state: "closed",
          merged_at: "2026-01-01T00:00:00Z",
          html_url: "u",
          head: HAPPY_HEAD,
        },
      ],
    });
    const outcome = await onboardRepo({
      ...baseArgs,
      defaultBranchHint: "main",
      octokitFactory: async () => mock,
    });
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") expect(outcome.reason).toBe("pr_declined");
  });

  it("createRef 422 + GET ref 200 (partial prior run) → continues to created", async () => {
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}/contents/{path}": () => httpError(404),
      "GET /repos/{owner}/{repo}/pulls": () => [],
      "GET /repos/{owner}/{repo}/git/ref/heads/{branch}": [
        () => ({ object: { sha: "abc" } }),
        () => ({ object: { sha: "abc" } }),
      ],
      "POST /repos/{owner}/{repo}/git/refs": () => httpError(422, "Reference already exists"),
      "PUT /repos/{owner}/{repo}/contents/{path}": () => ({}),
      "POST /repos/{owner}/{repo}/pulls": () => ({ number: 11, html_url: "u" }),
    });
    const outcome = await onboardRepo({
      ...baseArgs,
      defaultBranchHint: "main",
      octokitFactory: async () => mock,
    });
    expect(outcome.status).toBe("created");
  });

  it("createRef 422 + GET ref 404 → protection_blocked", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => log);
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}/contents/{path}": () => httpError(404),
      "GET /repos/{owner}/{repo}/pulls": () => [],
      "GET /repos/{owner}/{repo}/git/ref/heads/{branch}": [
        () => ({ object: { sha: "abc" } }),
        () => httpError(404),
      ],
      "POST /repos/{owner}/{repo}/git/refs": () => httpError(422, "blocked by protection"),
    });
    const outcome = await onboardRepo({
      ...baseArgs,
      defaultBranchHint: "main",
      octokitFactory: async () => mock,
    });
    expect(outcome).toEqual({ status: "protection_blocked", owner: "acme", repo: "widgets" });
    expect(
      warnSpy.mock.calls.some(
        (c) => (c[0] as { event?: string }).event === "onboard_protection_blocked",
      ),
    ).toBe(true);
  });

  it("createRef 403 → permission_denied/create_ref", async () => {
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}/contents/{path}": () => httpError(404),
      "GET /repos/{owner}/{repo}/pulls": () => [],
      "GET /repos/{owner}/{repo}/git/ref/heads/{branch}": () => ({ object: { sha: "abc" } }),
      "POST /repos/{owner}/{repo}/git/refs": () => httpError(403),
    });
    const outcome = await onboardRepo({
      ...baseArgs,
      defaultBranchHint: "main",
      octokitFactory: async () => mock,
    });
    expect(outcome).toEqual({
      status: "permission_denied",
      owner: "acme",
      repo: "widgets",
      step: "create_ref",
    });
  });

  it("PUT yml 422 → GET sha → re-PUT with sha → created (PUT called twice for yml path)", async () => {
    let putYmlCalls = 0;
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}/contents/{path}": (p) => {
        if (p.path === ".github/auto-merge.yml" && p.ref === "main") return httpError(404);
        if (p.path === ".github/auto-merge.yml" && p.ref === "auto-merge/onboarding")
          return { sha: "blob-sha" };
        return httpError(404);
      },
      "GET /repos/{owner}/{repo}/pulls": () => [],
      "GET /repos/{owner}/{repo}/git/ref/heads/{branch}": () => ({ object: { sha: "abc" } }),
      "POST /repos/{owner}/{repo}/git/refs": () => ({}),
      "PUT /repos/{owner}/{repo}/contents/{path}": (p) => {
        if (p.path === ".github/auto-merge.yml") {
          putYmlCalls += 1;
          if (putYmlCalls === 1) return httpError(422, "sha mismatch");
          return { commit: { sha: "c1" } };
        }
        return { commit: { sha: "c2" } };
      },
      "POST /repos/{owner}/{repo}/pulls": () => ({ number: 5, html_url: "u" }),
    });
    const outcome = await onboardRepo({
      ...baseArgs,
      defaultBranchHint: "main",
      octokitFactory: async () => mock,
    });
    expect(outcome.status).toBe("created");
    expect(putYmlCalls).toBe(2);
  });

  it("PUT yml 403 → permission_denied/put_yml", async () => {
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}/contents/{path}": () => httpError(404),
      "GET /repos/{owner}/{repo}/pulls": () => [],
      "GET /repos/{owner}/{repo}/git/ref/heads/{branch}": () => ({ object: { sha: "abc" } }),
      "POST /repos/{owner}/{repo}/git/refs": () => ({}),
      "PUT /repos/{owner}/{repo}/contents/{path}": () => httpError(403),
    });
    const outcome = await onboardRepo({
      ...baseArgs,
      defaultBranchHint: "main",
      octokitFactory: async () => mock,
    });
    expect(outcome).toEqual({
      status: "permission_denied",
      owner: "acme",
      repo: "widgets",
      step: "put_yml",
    });
  });

  it("POST pulls 422 → fetch existing open PR → return its number", async () => {
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}/contents/{path}": () => httpError(404),
      "GET /repos/{owner}/{repo}/pulls": [
        () => [],
        () => [
          {
            number: 77,
            state: "open",
            merged_at: null,
            html_url: "https://x/77",
            head: HAPPY_HEAD,
          },
        ],
      ],
      "GET /repos/{owner}/{repo}/git/ref/heads/{branch}": () => ({ object: { sha: "abc" } }),
      "POST /repos/{owner}/{repo}/git/refs": () => ({}),
      "PUT /repos/{owner}/{repo}/contents/{path}": () => ({}),
      "POST /repos/{owner}/{repo}/pulls": () => httpError(422, "PR already exists"),
    });
    const outcome = await onboardRepo({
      ...baseArgs,
      defaultBranchHint: "main",
      octokitFactory: async () => mock,
    });
    expect(outcome).toEqual({
      status: "created",
      owner: "acme",
      repo: "widgets",
      pr_number: 77,
      pr_url: "https://x/77",
    });
  });

  it("POST pulls 403 → permission_denied/create_pr", async () => {
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}/contents/{path}": () => httpError(404),
      "GET /repos/{owner}/{repo}/pulls": () => [],
      "GET /repos/{owner}/{repo}/git/ref/heads/{branch}": () => ({ object: { sha: "abc" } }),
      "POST /repos/{owner}/{repo}/git/refs": () => ({}),
      "PUT /repos/{owner}/{repo}/contents/{path}": () => ({}),
      "POST /repos/{owner}/{repo}/pulls": () => httpError(403),
    });
    const outcome = await onboardRepo({
      ...baseArgs,
      defaultBranchHint: "main",
      octokitFactory: async () => mock,
    });
    expect(outcome).toEqual({
      status: "permission_denied",
      owner: "acme",
      repo: "widgets",
      step: "create_pr",
    });
  });

  it("GET /repos returns 500 → failed/get_repo with err_message", async () => {
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}": () => httpError(500, "boom"),
    });
    const outcome = await onboardRepo({ ...baseArgs, octokitFactory: async () => mock });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.step).toBe("get_repo");
      expect(outcome.err_message).toBe("boom");
    }
  });

  it("invalid default_branch from GitHub → buildYmlConfig throws → failed/build_yml", async () => {
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}": () => ({ default_branch: "bad branch with spaces!" }),
      "GET /repos/{owner}/{repo}/contents/{path}": () => httpError(404),
      "GET /repos/{owner}/{repo}/pulls": () => [],
      "GET /repos/{owner}/{repo}/git/ref/heads/{branch}": () => ({ object: { sha: "abc" } }),
      "POST /repos/{owner}/{repo}/git/refs": () => ({}),
    });
    const outcome = await onboardRepo({ ...baseArgs, octokitFactory: async () => mock });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.step).toBe("build_yml");
    }
  });

  it("logs onboard_pr_created on success with installation_id payload", async () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => log);
    const mock = makeMockOctokit({
      "GET /repos/{owner}/{repo}/contents/{path}": () => httpError(404),
      "GET /repos/{owner}/{repo}/pulls": () => [],
      "GET /repos/{owner}/{repo}/git/ref/heads/{branch}": () => ({ object: { sha: "abc" } }),
      "POST /repos/{owner}/{repo}/git/refs": () => ({}),
      "PUT /repos/{owner}/{repo}/contents/{path}": () => ({}),
      "POST /repos/{owner}/{repo}/pulls": () => ({ number: 99, html_url: "u" }),
    });
    await onboardRepo({ ...baseArgs, defaultBranchHint: "main", octokitFactory: async () => mock });
    const created = infoSpy.mock.calls.find(
      (c) => (c[0] as { event?: string }).event === "onboard_pr_created",
    );
    expect(created).toBeDefined();
    expect(created?.[0]).toMatchObject({
      event: "onboard_pr_created",
      installation_id: 555,
      owner: "acme",
      repo: "widgets",
      pr: 99,
    });
  });
});
