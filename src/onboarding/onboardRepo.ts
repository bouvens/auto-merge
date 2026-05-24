import type { Octokit } from "@octokit/core";
import { log } from "../log.js";
import { buildPrBody, buildYmlConfig, DISPATCH_WORKFLOW_YML } from "./templates.js";

const ONBOARDING_BRANCH = "auto-merge/onboarding";
const YML_PATH = ".github/auto-merge.yml";
const WORKFLOW_PATH = ".github/workflows/auto-merge-dispatch.yml";

export type OnboardOutcome =
  | { status: "created"; owner: string; repo: string; pr_number: number; pr_url: string }
  | {
      status: "skipped";
      owner: string;
      repo: string;
      reason: "config_exists" | "pr_open" | "pr_declined";
    }
  | { status: "protection_blocked"; owner: string; repo: string }
  | { status: "permission_denied"; owner: string; repo: string; step: string }
  | { status: "token_mint_failed"; owner: string; repo: string }
  | { status: "failed"; owner: string; repo: string; step: string; err_message: string };

export interface OnboardArgs {
  installationId: number;
  owner: string;
  repo: string;
  defaultBranchHint?: string;
  senderLogin?: string;
  publicUrl?: string;
  octokitFactory: (id: number) => Promise<InstanceType<typeof Octokit> | undefined>;
}

function errStatus(err: unknown): number | undefined {
  return (err as { status?: number }).status;
}

function errMessage(err: unknown): string {
  return (err as { message?: string }).message ?? String(err);
}

function toB64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

interface PrItem {
  number: number;
  state: string;
  merged_at: string | null;
  html_url: string;
  head: { ref: string };
}

export async function onboardRepo(args: OnboardArgs): Promise<OnboardOutcome> {
  const { installationId, owner, repo } = args;
  const logBase = { installation_id: installationId, owner, repo };

  const octokit = await args.octokitFactory(installationId);
  if (!octokit) {
    return { status: "token_mint_failed", owner, repo };
  }

  let defaultBranch: string;
  if (args.defaultBranchHint) {
    defaultBranch = args.defaultBranchHint;
  } else {
    try {
      const r = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
      defaultBranch = (r.data as { default_branch?: string }).default_branch ?? "main";
    } catch (err) {
      const status = errStatus(err);
      if (status === 403) {
        log.warn(
          { ...logBase, event: "onboard_permission_denied", step: "get_repo" },
          "onboarding",
        );
        return { status: "permission_denied", owner, repo, step: "get_repo" };
      }
      log.warn(
        { ...logBase, event: "onboard_failed", step: "get_repo", status, msg: errMessage(err) },
        "onboarding",
      );
      return { status: "failed", owner, repo, step: "get_repo", err_message: errMessage(err) };
    }
  }

  try {
    await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path: YML_PATH,
      ref: defaultBranch,
    });
    log.info({ ...logBase, event: "onboard_skipped_config_exists" }, "onboarding");
    return { status: "skipped", owner, repo, reason: "config_exists" };
  } catch (err) {
    const status = errStatus(err);
    if (status === 403) {
      log.warn(
        { ...logBase, event: "onboard_permission_denied", step: "get_contents" },
        "onboarding",
      );
      return { status: "permission_denied", owner, repo, step: "get_contents" };
    }
    if (status !== 404) {
      log.warn(
        { ...logBase, event: "onboard_failed", step: "get_contents", status, msg: errMessage(err) },
        "onboarding",
      );
      return { status: "failed", owner, repo, step: "get_contents", err_message: errMessage(err) };
    }
  }

  try {
    const prs = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      head: `${owner}:${ONBOARDING_BRANCH}`,
      state: "all",
      per_page: 20,
    });
    const items = (prs.data as PrItem[]) ?? [];
    const match = items.find((p) => p.head?.ref === ONBOARDING_BRANCH);
    if (match) {
      if (match.state === "open") {
        log.info({ ...logBase, event: "onboard_skipped_pr_open", pr: match.number }, "onboarding");
        return { status: "skipped", owner, repo, reason: "pr_open" };
      }
      log.info(
        { ...logBase, event: "onboard_skipped_pr_declined", pr: match.number },
        "onboarding",
      );
      return { status: "skipped", owner, repo, reason: "pr_declined" };
    }
  } catch (err) {
    const status = errStatus(err);
    if (status === 403) {
      log.warn(
        { ...logBase, event: "onboard_permission_denied", step: "list_pulls" },
        "onboarding",
      );
      return { status: "permission_denied", owner, repo, step: "list_pulls" };
    }
    log.warn(
      { ...logBase, event: "onboard_failed", step: "list_pulls", status, msg: errMessage(err) },
      "onboarding",
    );
    return { status: "failed", owner, repo, step: "list_pulls", err_message: errMessage(err) };
  }

  let baseSha: string;
  try {
    const ref = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/{branch}", {
      owner,
      repo,
      branch: defaultBranch,
    });
    baseSha = (ref.data as { object: { sha: string } }).object.sha;
  } catch (err) {
    const status = errStatus(err);
    if (status === 403) {
      log.warn(
        { ...logBase, event: "onboard_permission_denied", step: "get_base_ref" },
        "onboarding",
      );
      return { status: "permission_denied", owner, repo, step: "get_base_ref" };
    }
    log.warn(
      { ...logBase, event: "onboard_failed", step: "get_base_ref", status, msg: errMessage(err) },
      "onboarding",
    );
    return { status: "failed", owner, repo, step: "get_base_ref", err_message: errMessage(err) };
  }

  try {
    await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner,
      repo,
      ref: `refs/heads/${ONBOARDING_BRANCH}`,
      sha: baseSha,
    });
  } catch (err) {
    const status = errStatus(err);
    if (status === 422) {
      let branchExists = false;
      try {
        await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/{branch}", {
          owner,
          repo,
          branch: ONBOARDING_BRANCH,
        });
        branchExists = true;
      } catch (probe) {
        if (errStatus(probe) !== 404) {
          log.warn(
            {
              ...logBase,
              event: "onboard_failed",
              step: "probe_ref",
              status: errStatus(probe),
              msg: errMessage(probe),
            },
            "onboarding",
          );
          return {
            status: "failed",
            owner,
            repo,
            step: "probe_ref",
            err_message: errMessage(probe),
          };
        }
      }
      if (!branchExists) {
        log.warn({ ...logBase, event: "onboard_protection_blocked" }, "onboarding");
        return { status: "protection_blocked", owner, repo };
      }
    } else if (status === 403) {
      log.warn(
        { ...logBase, event: "onboard_permission_denied", step: "create_ref" },
        "onboarding",
      );
      return { status: "permission_denied", owner, repo, step: "create_ref" };
    } else {
      log.warn(
        { ...logBase, event: "onboard_failed", step: "create_ref", status, msg: errMessage(err) },
        "onboarding",
      );
      return { status: "failed", owner, repo, step: "create_ref", err_message: errMessage(err) };
    }
  }

  let ymlContent: string;
  try {
    ymlContent = buildYmlConfig(defaultBranch);
  } catch (err) {
    log.warn(
      { ...logBase, event: "onboard_failed", step: "build_yml", msg: errMessage(err) },
      "onboarding",
    );
    return { status: "failed", owner, repo, step: "build_yml", err_message: errMessage(err) };
  }

  async function putFileIdempotent(
    path: string,
    content: string,
    message: string,
    step: string,
  ): Promise<OnboardOutcome | null> {
    try {
      await octokit!.request("PUT /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path,
        message,
        content: toB64(content),
        branch: ONBOARDING_BRANCH,
      });
      return null;
    } catch (err) {
      const status = errStatus(err);
      if (status === 403) {
        log.warn({ ...logBase, event: "onboard_permission_denied", step }, "onboarding");
        return { status: "permission_denied", owner, repo, step };
      }
      if (status !== 422) {
        log.warn(
          { ...logBase, event: "onboard_failed", step, status, msg: errMessage(err) },
          "onboarding",
        );
        return { status: "failed", owner, repo, step, err_message: errMessage(err) };
      }
    }
    try {
      const existing = await octokit!.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path,
        ref: ONBOARDING_BRANCH,
      });
      const sha = (existing.data as { sha?: string }).sha;
      await octokit!.request("PUT /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path,
        message,
        content: toB64(content),
        branch: ONBOARDING_BRANCH,
        sha,
      });
      return null;
    } catch (err) {
      const status = errStatus(err);
      if (status === 403) {
        log.warn({ ...logBase, event: "onboard_permission_denied", step }, "onboarding");
        return { status: "permission_denied", owner, repo, step };
      }
      log.warn(
        { ...logBase, event: "onboard_failed", step, status, msg: errMessage(err) },
        "onboarding",
      );
      return { status: "failed", owner, repo, step, err_message: errMessage(err) };
    }
  }

  const ymlOutcome = await putFileIdempotent(
    YML_PATH,
    ymlContent,
    "auto-merge: add cascade config",
    "put_yml",
  );
  if (ymlOutcome) return ymlOutcome;

  const wfOutcome = await putFileIdempotent(
    WORKFLOW_PATH,
    DISPATCH_WORKFLOW_YML,
    "auto-merge: add dispatch workflow",
    "put_workflow",
  );
  if (wfOutcome) return wfOutcome;

  const body = buildPrBody({
    owner,
    repo,
    defaultBranch,
    senderLogin: args.senderLogin,
    publicUrl: args.publicUrl,
  });
  try {
    const pr = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      title: "auto-merge: bootstrap configuration",
      head: ONBOARDING_BRANCH,
      base: defaultBranch,
      draft: true,
      body,
    });
    const data = pr.data as { number: number; html_url: string };
    log.info({ ...logBase, event: "onboard_pr_created", pr: data.number }, "onboarding");
    return { status: "created", owner, repo, pr_number: data.number, pr_url: data.html_url };
  } catch (err) {
    const status = errStatus(err);
    if (status === 403) {
      log.warn({ ...logBase, event: "onboard_permission_denied", step: "create_pr" }, "onboarding");
      return { status: "permission_denied", owner, repo, step: "create_pr" };
    }
    if (status === 422) {
      try {
        const existing = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
          owner,
          repo,
          head: `${owner}:${ONBOARDING_BRANCH}`,
          state: "open",
          per_page: 5,
        });
        const items = (existing.data as PrItem[]) ?? [];
        const match = items.find((p) => p.head?.ref === ONBOARDING_BRANCH);
        if (match) {
          log.info({ ...logBase, event: "onboard_pr_recovered", pr: match.number }, "onboarding");
          return {
            status: "created",
            owner,
            repo,
            pr_number: match.number,
            pr_url: match.html_url,
          };
        }
      } catch (probe) {
        log.warn(
          {
            ...logBase,
            event: "onboard_failed",
            step: "create_pr_recover",
            status: errStatus(probe),
            msg: errMessage(probe),
          },
          "onboarding",
        );
        return {
          status: "failed",
          owner,
          repo,
          step: "create_pr_recover",
          err_message: errMessage(probe),
        };
      }
    }
    log.warn(
      { ...logBase, event: "onboard_failed", step: "create_pr", status, msg: errMessage(err) },
      "onboarding",
    );
    return { status: "failed", owner, repo, step: "create_pr", err_message: errMessage(err) };
  }
}
