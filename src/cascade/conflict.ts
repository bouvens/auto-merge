import type { Octokit } from "@octokit/core";
import { log } from "../log.js";

export interface ConflictPRDeps {
  octokit: Octokit;
  owner: string;
  repo: string;
}

export interface ConflictPROpts {
  src: string;
  tgt: string;
  source_sha: string;
  runId: string;
  checkRunHtmlUrl: string | null;
  headCommitAuthor: { username?: string | null; email: string };
  // summaryPrefix surfaces branch-protection rule name on PR body's first line; falls back to plain conflict text when omitted.
  summaryPrefix?: string;
}

export type ConflictPRResult =
  | { ok: true; pr_url: string; pr_number: number; reused: boolean }
  | { ok: false; error: string };

interface ExistingPR {
  html_url: string;
  number: number;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number }).status;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function findOpenConflictPR(
  deps: ConflictPRDeps,
  branch: string,
  base: string,
): Promise<ExistingPR | null> {
  const resp = await deps.octokit.request("GET /repos/{owner}/{repo}/pulls", {
    owner: deps.owner,
    repo: deps.repo,
    head: `${deps.owner}:${branch}`,
    base,
    state: "open",
  });
  const list = resp.data as ExistingPR[];
  return list.length > 0 ? list[0]! : null;
}

async function resolveAuthor(deps: ConflictPRDeps, opts: ConflictPROpts): Promise<string> {
  if (opts.headCommitAuthor.username) {
    return `@${opts.headCommitAuthor.username}`;
  }
  try {
    const resp = await deps.octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner: deps.owner,
      repo: deps.repo,
      ref: opts.source_sha,
    });
    const data = resp.data as { author?: { login?: string } | null };
    const login = data.author?.login;
    if (login) {
      return `@${login}`;
    }
  } catch {
    // Email fallback below is the documented final step; swallow so caller proceeds.
  }
  return `(author email: ${opts.headCommitAuthor.email})`;
}

function composeBody(opts: ConflictPROpts, mention: string): string {
  const checkRunLine = opts.checkRunHtmlUrl ?? "(not available)";
  const lines = [
    `Auto-merge \`${opts.src}\` → \`${opts.tgt}\` failed on commit \`${shortSha(opts.source_sha)}\` (cc ${mention}).`,
    `run_id: ${opts.runId}`,
    `Check Run: ${checkRunLine}`,
  ];
  if (opts.summaryPrefix) {
    lines.unshift(opts.summaryPrefix);
  }
  return lines.join("\n");
}

export async function createConflictPR(
  deps: ConflictPRDeps,
  opts: ConflictPROpts,
): Promise<ConflictPRResult> {
  const shaShort = shortSha(opts.source_sha);
  const branch = `auto-merge/conflict-${opts.src}-${opts.tgt}`;
  const logCtx = {
    owner: deps.owner,
    repo: deps.repo,
    run_id: opts.runId,
    source: opts.src,
    target: opts.tgt,
    source_sha: opts.source_sha,
    branch,
  };

  let branchExisted = false;
  try {
    await deps.octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner: deps.owner,
      repo: deps.repo,
      ref: `refs/heads/${branch}`,
      sha: opts.source_sha,
    });
    log.info(logCtx, "cascade_conflict_branch_created");
  } catch (err) {
    // 422 = the per-pair branch already exists from an earlier unresolved conflict; reuse its open PR.
    if (statusOf(err) !== 422) {
      log.error({ ...logCtx, err }, "cascade_conflict_pr_failed");
      return { ok: false, error: `createRef failed: ${messageOf(err)}` };
    }
    branchExisted = true;
    log.info(logCtx, "cascade_conflict_branch_exists");
  }

  if (branchExisted) {
    try {
      const existing = await findOpenConflictPR(deps, branch, opts.tgt);
      if (existing) {
        log.info({ ...logCtx, pr_number: existing.number }, "cascade_conflict_pr_reused");
        return { ok: true, pr_url: existing.html_url, pr_number: existing.number, reused: true };
      }
    } catch (err) {
      log.error({ ...logCtx, err }, "cascade_conflict_pr_failed");
      return { ok: false, error: `pulls.list failed: ${messageOf(err)}` };
    }
  }

  const mention = await resolveAuthor(deps, opts);
  const body = composeBody(opts, mention);
  const title = `Auto-merge conflict: ${opts.src} → ${opts.tgt} (${shaShort})`;

  try {
    const resp = await deps.octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner: deps.owner,
      repo: deps.repo,
      head: branch,
      base: opts.tgt,
      title,
      body,
    });
    const data = resp.data as { html_url: string; number: number };
    log.info({ ...logCtx, pr_number: data.number }, "cascade_conflict_pr_created");
    return { ok: true, pr_url: data.html_url, pr_number: data.number, reused: false };
  } catch (err) {
    // 422 on pulls.create means a concurrent PR was opened between our list-check and create.
    if (statusOf(err) === 422) {
      try {
        const existing = await findOpenConflictPR(deps, branch, opts.tgt);
        if (existing) {
          log.info({ ...logCtx, pr_number: existing.number }, "cascade_conflict_pr_reused");
          return { ok: true, pr_url: existing.html_url, pr_number: existing.number, reused: true };
        }
      } catch (retryErr) {
        log.error({ ...logCtx, err: retryErr }, "cascade_conflict_pr_failed");
        return { ok: false, error: `pulls.list retry failed: ${messageOf(retryErr)}` };
      }
      log.error({ ...logCtx, err }, "cascade_conflict_pr_failed");
      return { ok: false, error: "pulls.create 422 race; no existing open PR found" };
    }
    log.error({ ...logCtx, err }, "cascade_conflict_pr_failed");
    return { ok: false, error: `pulls.create failed: ${messageOf(err)}` };
  }
}
