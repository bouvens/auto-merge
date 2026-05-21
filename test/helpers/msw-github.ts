// Shared msw GitHub harness — keeps integration tests focused on behavior, not on setting up identical handlers in each file.
import { HttpResponse, http } from "msw";
import { type SetupServer, setupServer } from "msw/node";

export interface CompareData {
  ahead_by: number;
  total_commits: number;
  commits: Array<{ sha: string; commit: { message: string } }>;
  base_commit: { sha: string };
}

export interface OpenPR {
  html_url: string;
  number: number;
  head: { ref: string };
  base: { ref: string };
}

export interface ProtectionResponse {
  required_pull_request_reviews?: object | null;
  required_status_checks?: { contexts?: string[]; checks?: unknown[] } | null;
  required_signatures?: { enabled: boolean };
  required_linear_history?: { enabled: boolean };
  restrictions?: object | null;
  lock_branch?: { enabled: boolean };
}

export interface MockInstallation {
  id: number;
  suspended_at?: string | null;
  account: { login: string };
}

export interface MockInstallationRepo {
  name: string;
  full_name: string;
  owner: { login: string };
}

export interface GitHubMockState {
  // branch name → head commit sha
  branches: Record<string, string>;
  compare: CompareData;
  // 201 = merged; 204 = already up-to-date; 409 = conflict; 422 = unprocessable; 500 = server error.
  mergeStatus: 201 | 204 | 409 | 422 | 500;
  // Optional override for the merge commit sha returned on 201.
  mergeSha: string;
  // controls POST /git/refs idempotency: 200 → 201 created; true → 422 already exists.
  refExists: boolean;
  // PRs returned from GET /repos/:owner/:repo/pulls (filtered by head/base).
  openPRs: OpenPR[];
  // controls POST /repos/:owner/:repo/pulls outcome.
  pullsCreateStatus: 201 | 422;
  // Snapshots of branch heads observed BEFORE the first POST /merges call — lets `setBranchHeadAfterMerge` simulate stale-base retry.
  branchHeadAfter?: Record<string, string>;
  // commit author lookup result for resolveAuthor.
  commitAuthorLogin: string | null;
  // bot identity exposed via /app + /users/:slug[bot]
  appSlug: string;
  botUserId: number;
  // undefined → 403 (no admin permission), null → 404 (no protection rules), object → 200 (rules present).
  protection: ProtectionResponse | null | undefined;
  // cron safety-net: list of installations returned by GET /app/installations
  installations: MockInstallation[];
  // cron safety-net: repos per installation returned by GET /installation/repositories
  installationRepos: Record<number, MockInstallationRepo[]>;
  // identifies which installation token is in use — set by test setup before tick invocation
  currentInstallationId: number | null;
}

export interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
}

export interface MswGitHubHarness {
  server: SetupServer;
  state: GitHubMockState;
  // mutators — let tests reshape responses per-case without rebuilding handlers.
  setMergeStatus(status: GitHubMockState["mergeStatus"]): void;
  setBranchHead(branch: string, sha: string): void;
  setBranchHeadAfterMerge(branch: string, sha: string): void;
  setRefExists(exists: boolean): void;
  setPullsCreateStatus(status: GitHubMockState["pullsCreateStatus"]): void;
  addOpenPR(pr: OpenPR): void;
  setConfigYaml(yaml: string): void;
  setProtection(value: ProtectionResponse | null | undefined): void;
  // call counters — exposed so integration tests can assert exact request shapes.
  compareCalls: RecordedRequest[];
  mergeCalls: RecordedRequest[];
  branchCalls: RecordedRequest[];
  createRefCalls: RecordedRequest[];
  pullsListCalls: RecordedRequest[];
  pullsCreateCalls: RecordedRequest[];
  commitCalls: RecordedRequest[];
  checkRunCreateCalls: RecordedRequest[];
  checkRunPatchCalls: RecordedRequest[];
  configCalls: RecordedRequest[];
  protectionCalls: RecordedRequest[];
  installationsCalls: RecordedRequest[];
  installationReposCalls: RecordedRequest[];
  resetCounters(): void;
}

const DEFAULT_COMPARE: CompareData = {
  ahead_by: 1,
  total_commits: 1,
  commits: [
    { sha: "aaaaaaa1111111111111111111111111111111aa", commit: { message: "feat: change" } },
  ],
  base_commit: { sha: "tgt-head-before" },
};

function defaultState(overrides: Partial<GitHubMockState>): GitHubMockState {
  return {
    branches: { ...(overrides.branches ?? {}) },
    compare: overrides.compare ?? DEFAULT_COMPARE,
    mergeStatus: overrides.mergeStatus ?? 201,
    mergeSha: overrides.mergeSha ?? "merge-commit-sha-zzzzzzzzzzzzzzzzzzzzzzzz",
    refExists: overrides.refExists ?? false,
    openPRs: overrides.openPRs ?? [],
    pullsCreateStatus: overrides.pullsCreateStatus ?? 201,
    branchHeadAfter: overrides.branchHeadAfter,
    commitAuthorLogin: overrides.commitAuthorLogin ?? "author-login",
    appSlug: overrides.appSlug ?? "auto-merge-test",
    botUserId: overrides.botUserId ?? 41898282,
    protection: "protection" in overrides ? overrides.protection : null,
    installations: overrides.installations ?? [],
    installationRepos: overrides.installationRepos ?? {},
    currentInstallationId: overrides.currentInstallationId ?? null,
  };
}

function base64(input: string): string {
  return Buffer.from(input, "utf8").toString("base64");
}

const DEFAULT_CONFIG_YAML = `main_branch: main
release_branch: release
dev_branch: dev
`;

export function setupMswGitHub(initial: Partial<GitHubMockState> = {}): MswGitHubHarness {
  const state = defaultState(initial);
  let configYaml = DEFAULT_CONFIG_YAML;

  // mergeCallSeq tracks how many POST /merges have run — lets `branchHeadAfter` activate on the SECOND GET /branches call (post-409).
  let mergeCallSeq = 0;

  const compareCalls: RecordedRequest[] = [];
  const mergeCalls: RecordedRequest[] = [];
  const branchCalls: RecordedRequest[] = [];
  const createRefCalls: RecordedRequest[] = [];
  const pullsListCalls: RecordedRequest[] = [];
  const pullsCreateCalls: RecordedRequest[] = [];
  const commitCalls: RecordedRequest[] = [];
  const checkRunCreateCalls: RecordedRequest[] = [];
  const checkRunPatchCalls: RecordedRequest[] = [];
  const configCalls: RecordedRequest[] = [];
  const protectionCalls: RecordedRequest[] = [];
  const installationsCalls: RecordedRequest[] = [];
  const installationReposCalls: RecordedRequest[] = [];

  // Octokit auth-app posts to /app/installations/:id/access_tokens to mint an installation token; respond with a fake bearer + future expiry.
  const handlers = [
    http.post("https://api.github.com/app/installations/:installation_id/access_tokens", () =>
      HttpResponse.json(
        {
          token: "ghs_test_installation_token",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          permissions: { contents: "write", pull_requests: "write", checks: "write" },
          repository_selection: "all",
        },
        { status: 201 },
      ),
    ),

    http.get("https://api.github.com/repos/:owner/:repo/contents/:path", ({ request }) => {
      configCalls.push({ method: "GET", url: request.url });
      return HttpResponse.json({
        name: "auto-merge.yml",
        path: ".github/auto-merge.yml",
        type: "file",
        encoding: "base64",
        content: base64(configYaml),
      });
    }),

    http.get("https://api.github.com/repos/:owner/:repo/compare/:basehead", ({ request }) => {
      compareCalls.push({ method: "GET", url: request.url });
      return HttpResponse.json(state.compare);
    }),

    http.post("https://api.github.com/repos/:owner/:repo/merges", async ({ request }) => {
      const body = await request
        .clone()
        .json()
        .catch(() => undefined);
      mergeCalls.push({ method: "POST", url: request.url, body });
      mergeCallSeq += 1;
      const status = state.mergeStatus;
      if (status === 201) {
        return HttpResponse.json(
          {
            sha: state.mergeSha,
            commit: { message: (body as { commit_message?: string } | undefined)?.commit_message },
          },
          { status: 201 },
        );
      }
      if (status === 204) {
        return new HttpResponse(null, { status: 204 });
      }
      return HttpResponse.json({ message: `merge ${status}` }, { status });
    }),

    http.get(
      "https://api.github.com/repos/:owner/:repo/branches/:branch",
      ({ params, request }) => {
        branchCalls.push({ method: "GET", url: request.url });
        const branch = params.branch as string;
        // After at least one POST /merges, return branchHeadAfter override (simulates target moving — D-10 stale-base trigger).
        if (mergeCallSeq > 0 && state.branchHeadAfter?.[branch]) {
          return HttpResponse.json({
            name: branch,
            commit: { sha: state.branchHeadAfter[branch] },
          });
        }
        const sha = state.branches[branch];
        if (sha === undefined) {
          return HttpResponse.json({ message: "Branch not found" }, { status: 404 });
        }
        return HttpResponse.json({ name: branch, commit: { sha } });
      },
    ),

    http.get(
      "https://api.github.com/repos/:owner/:repo/branches/:branch/protection",
      ({ request }) => {
        protectionCalls.push({ method: "GET", url: request.url });
        if (state.protection === undefined) {
          return HttpResponse.json({ message: "Not Found" }, { status: 403 });
        }
        if (state.protection === null) {
          return HttpResponse.json({ message: "Branch not protected" }, { status: 404 });
        }
        return HttpResponse.json(state.protection);
      },
    ),

    http.post("https://api.github.com/repos/:owner/:repo/git/refs", async ({ request }) => {
      const body = await request
        .clone()
        .json()
        .catch(() => undefined);
      createRefCalls.push({ method: "POST", url: request.url, body });
      if (state.refExists) {
        return HttpResponse.json({ message: "Reference already exists" }, { status: 422 });
      }
      const ref = (body as { ref?: string } | undefined)?.ref ?? "refs/heads/unknown";
      return HttpResponse.json({ ref, object: { sha: "ref-sha" } }, { status: 201 });
    }),

    http.get("https://api.github.com/repos/:owner/:repo/pulls", ({ request }) => {
      pullsListCalls.push({ method: "GET", url: request.url });
      const url = new URL(request.url);
      const headParam = url.searchParams.get("head");
      const baseParam = url.searchParams.get("base");
      const matches = state.openPRs.filter((pr) => {
        const headRefMatches =
          headParam === null || headParam.endsWith(`:${pr.head.ref}`) || headParam === pr.head.ref;
        const baseMatches = baseParam === null || baseParam === pr.base.ref;
        return headRefMatches && baseMatches;
      });
      return HttpResponse.json(
        matches.map((m) => ({
          html_url: m.html_url,
          number: m.number,
          head: { ref: m.head.ref },
          base: { ref: m.base.ref },
          state: "open",
        })),
      );
    }),

    http.post("https://api.github.com/repos/:owner/:repo/pulls", async ({ request }) => {
      const body = await request
        .clone()
        .json()
        .catch(() => undefined);
      pullsCreateCalls.push({ method: "POST", url: request.url, body });
      if (state.pullsCreateStatus === 422) {
        return HttpResponse.json({ message: "Validation Failed" }, { status: 422 });
      }
      const b = body as { head?: string; base?: string; title?: string; body?: string } | undefined;
      return HttpResponse.json(
        {
          html_url: `https://github.com/owner/repo/pull/${pullsCreateCalls.length}`,
          number: pullsCreateCalls.length,
          head: { ref: b?.head ?? "unknown" },
          base: { ref: b?.base ?? "unknown" },
          title: b?.title,
          body: b?.body,
        },
        { status: 201 },
      );
    }),

    http.get("https://api.github.com/repos/:owner/:repo/commits/:ref", ({ params, request }) => {
      commitCalls.push({ method: "GET", url: request.url });
      const ref = params.ref as string;
      return HttpResponse.json({
        sha: ref,
        author: state.commitAuthorLogin ? { login: state.commitAuthorLogin, id: 1 } : null,
        commit: {
          message: "commit",
          author: { name: "Author", email: "author@example.com" },
        },
      });
    }),

    http.post("https://api.github.com/repos/:owner/:repo/check-runs", async ({ request }) => {
      const body = await request
        .clone()
        .json()
        .catch(() => undefined);
      checkRunCreateCalls.push({ method: "POST", url: request.url, body });
      return HttpResponse.json(
        {
          id: 100 + checkRunCreateCalls.length,
          html_url: `https://github.com/owner/repo/runs/${100 + checkRunCreateCalls.length}`,
        },
        { status: 201 },
      );
    }),

    http.patch(
      "https://api.github.com/repos/:owner/:repo/check-runs/:check_run_id",
      async ({ params, request }) => {
        const body = await request
          .clone()
          .json()
          .catch(() => undefined);
        checkRunPatchCalls.push({ method: "PATCH", url: request.url, body });
        return HttpResponse.json({ id: Number(params.check_run_id) });
      },
    ),

    http.get("https://api.github.com/app", () =>
      HttpResponse.json({ slug: state.appSlug, id: 1234 }),
    ),

    http.get("https://api.github.com/users/:username", ({ params }) =>
      HttpResponse.json({ id: state.botUserId, login: params.username }),
    ),

    http.get("https://api.github.com/app/installations", ({ request }) => {
      installationsCalls.push({ method: "GET", url: request.url });
      return HttpResponse.json(
        state.installations.map((i) => ({ ...i, suspended_at: i.suspended_at ?? null })),
      );
    }),

    http.get("https://api.github.com/installation/repositories", ({ request }) => {
      installationReposCalls.push({ method: "GET", url: request.url });
      const id = state.currentInstallationId;
      const repos = id !== null ? (state.installationRepos[id] ?? []) : [];
      return HttpResponse.json({ total_count: repos.length, repositories: repos });
    }),
  ];

  const server = setupServer(...handlers);

  return {
    server,
    state,
    setMergeStatus(status) {
      state.mergeStatus = status;
    },
    setBranchHead(branch, sha) {
      state.branches[branch] = sha;
    },
    setBranchHeadAfterMerge(branch, sha) {
      if (!state.branchHeadAfter) state.branchHeadAfter = {};
      state.branchHeadAfter[branch] = sha;
    },
    setRefExists(exists) {
      state.refExists = exists;
    },
    setPullsCreateStatus(status) {
      state.pullsCreateStatus = status;
    },
    addOpenPR(pr) {
      state.openPRs.push(pr);
    },
    setConfigYaml(yaml) {
      configYaml = yaml;
    },
    setProtection(value) {
      state.protection = value;
    },
    compareCalls,
    mergeCalls,
    branchCalls,
    createRefCalls,
    pullsListCalls,
    pullsCreateCalls,
    commitCalls,
    checkRunCreateCalls,
    checkRunPatchCalls,
    configCalls,
    protectionCalls,
    installationsCalls,
    installationReposCalls,
    resetCounters() {
      compareCalls.length = 0;
      mergeCalls.length = 0;
      branchCalls.length = 0;
      createRefCalls.length = 0;
      pullsListCalls.length = 0;
      pullsCreateCalls.length = 0;
      commitCalls.length = 0;
      checkRunCreateCalls.length = 0;
      checkRunPatchCalls.length = 0;
      configCalls.length = 0;
      protectionCalls.length = 0;
      installationsCalls.length = 0;
      installationReposCalls.length = 0;
      mergeCallSeq = 0;
    },
  };
}
