import type { Octokit } from "@octokit/core";
import { log } from "../log.js";

export interface CheckRunDeps {
  octokit: Octokit;
  owner: string;
  repo: string;
}

export interface CreateInProgressOpts {
  source_sha: string;
  src: string;
  tgt: string;
  runId: string;
}

export interface CompleteOpts {
  check_run_id: number;
  src: string;
  tgt: string;
  runId: string;
}

export interface FailureOpts extends CompleteOpts {
  kind: "real_conflict" | "unknown_error";
  detail: string;
}

export interface FailureCheckRunOpts {
  head_sha: string;
  name: string;
  title: string;
  summary: string;
}

// summary cap 1024 chars — well under GitHub's 64KB annotation limit, prevents log/CI clutter from huge error payloads.
const SUMMARY_MAX = 1024;
function clampSummary(s: string): string {
  if (s.length <= SUMMARY_MAX) return s;
  return `${s.slice(0, SUMMARY_MAX)}…\n[truncated]`;
}

// POST creates the check run; subsequent transitions MUST PATCH the same check_run_id — a second POST with the same external_id creates a duplicate (D-24, RESEARCH.md Pitfall 2).
export async function createInProgress(
  deps: CheckRunDeps,
  opts: CreateInProgressOpts,
): Promise<{ check_run_id: number; html_url: string } | null> {
  try {
    const resp = await deps.octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner: deps.owner,
      repo: deps.repo,
      head_sha: opts.source_sha,
      name: `auto-merge: ${opts.src} → ${opts.tgt}`,
      status: "in_progress",
      external_id: `${opts.runId}:${opts.src}:${opts.tgt}`,
      started_at: new Date().toISOString(),
    });
    const data = resp.data as { id: number; html_url: string };
    return { check_run_id: data.id, html_url: data.html_url };
  } catch (err) {
    // Check Run is observability — failing to create it MUST NOT abort the cascade; structured error log gives operators a debug signal.
    log.error(
      {
        err,
        run_id: opts.runId,
        owner: deps.owner,
        repo: deps.repo,
        src: opts.src,
        tgt: opts.tgt,
      },
      "check-run-create-failed",
    );
    return null;
  }
}

export async function completeSuccess(deps: CheckRunDeps, opts: CompleteOpts): Promise<void> {
  try {
    await deps.octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      owner: deps.owner,
      repo: deps.repo,
      check_run_id: opts.check_run_id,
      status: "completed",
      conclusion: "success",
      completed_at: new Date().toISOString(),
      output: {
        title: `Merged ${opts.src} → ${opts.tgt}`,
        summary: `run_id: ${opts.runId}`,
      },
    });
  } catch (err) {
    // Check Run is observability — failing to update it MUST NOT abort the cascade; structured error log gives operators a debug signal.
    log.error(
      {
        err,
        run_id: opts.runId,
        owner: deps.owner,
        repo: deps.repo,
        src: opts.src,
        tgt: opts.tgt,
      },
      "check-run-update-failed",
    );
  }
}

export async function completeFailure(deps: CheckRunDeps, opts: FailureOpts): Promise<void> {
  try {
    const titlePrefix = opts.kind === "real_conflict" ? "Conflict" : "Failed";
    await deps.octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      owner: deps.owner,
      repo: deps.repo,
      check_run_id: opts.check_run_id,
      status: "completed",
      conclusion: "failure",
      completed_at: new Date().toISOString(),
      output: {
        title: `${titlePrefix} ${opts.src} → ${opts.tgt}`,
        summary: clampSummary(`${opts.kind}: ${opts.detail}\nrun_id: ${opts.runId}`),
      },
    });
  } catch (err) {
    // Check Run is observability — failing to update it MUST NOT abort the cascade; structured error log gives operators a debug signal.
    log.error(
      {
        err,
        run_id: opts.runId,
        owner: deps.owner,
        repo: deps.repo,
        src: opts.src,
        tgt: opts.tgt,
      },
      "check-run-update-failed",
    );
  }
}

export async function createFailureCheckRun(
  deps: CheckRunDeps,
  opts: FailureCheckRunOpts,
): Promise<void> {
  try {
    await deps.octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner: deps.owner,
      repo: deps.repo,
      head_sha: opts.head_sha,
      name: opts.name,
      status: "completed",
      conclusion: "failure",
      output: {
        title: opts.title,
        summary: clampSummary(opts.summary),
      },
    });
  } catch (err) {
    // Check Run is observability — failing to create it MUST NOT abort the caller; structured error log gives operators a debug signal.
    log.error(
      { err, owner: deps.owner, repo: deps.repo, head_sha: opts.head_sha },
      "check-run-create-failed",
    );
  }
}
