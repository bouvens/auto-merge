import type { Octokit } from "@octokit/core";
import { log } from "../log.js";
import * as checkRun from "./checkRun.js";
import { buildCommitMessage, type CompareData } from "./commitMessage.js";
import { type Endpoint, mapError } from "./errorMap.js";
import { protectionCheck } from "./protectionCheck.js";

export interface MergeStepDeps {
  octokit: Octokit;
  owner: string;
  repo: string;
  // GitHub App slug — restrictions.apps[].slug uses the raw slug without the [bot] suffix.
  appSlug: string;
}

export interface MergeStepOpts {
  src: string;
  tgt: string;
  source_sha: string;
  runId: string;
  deliveryId: string;
}

export type MergeOutcome =
  | { outcome: "merged"; sha: string; check_run_id: number | null }
  | { outcome: "skipped"; reason: "ahead_by_zero" | "status_204" }
  | {
      outcome: "conflict";
      source_sha: string;
      check_run_id: number | null;
      check_run_html_url: string | null;
    }
  | {
      outcome: "unknown_error";
      status?: number;
      message: string;
      check_run_id: number | null;
    }
  | {
      outcome: "permission_error";
      // permission_error kind distinguishes API-permission failure from real conflicts / unknown errors.
      endpoint: Endpoint;
      status: number;
      missing_permission: string;
      check_run_id: number | null;
    }
  | {
      outcome: "protection_blocked";
      rule: string;
      source_sha: string;
      check_run_id: number | null;
      check_run_html_url: string | null;
    };

interface OctokitErrorShape {
  status?: number;
  response?: { data?: { message?: string } };
  message?: string;
}

function classifyError(err: unknown): { status?: number; message: string } {
  const e = err as OctokitErrorShape;
  const message = e?.response?.data?.message ?? e?.message ?? String(err);
  return { status: typeof e?.status === "number" ? e.status : undefined, message };
}

async function patchCheckRunNeutral(
  deps: MergeStepDeps,
  check_run_id: number,
  opts: MergeStepOpts,
): Promise<void> {
  try {
    // 204 race resolves the Check Run as neutral — leaving in_progress would confuse the PR view; D-08 forbids success/failure for skip-like outcomes (Pitfall 5).
    await deps.octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      owner: deps.owner,
      repo: deps.repo,
      check_run_id,
      status: "completed",
      conclusion: "neutral",
      completed_at: new Date().toISOString(),
      output: {
        title: `Skipped ${opts.src} → ${opts.tgt}`,
        summary: "status 204 race — nothing to merge by the time POST /merges ran",
      },
    });
  } catch (err) {
    log.error(
      {
        err,
        run_id: opts.runId,
        delivery_id: opts.deliveryId,
        owner: deps.owner,
        repo: deps.repo,
        src: opts.src,
        tgt: opts.tgt,
      },
      "check-run-update-failed",
    );
  }
}

async function attemptMerge(
  deps: MergeStepDeps,
  opts: MergeStepOpts,
  commit_message: string,
): Promise<{ kind: "ok"; status: number; sha?: string } | { kind: "err"; err: unknown }> {
  try {
    const resp = await deps.octokit.request("POST /repos/{owner}/{repo}/merges", {
      owner: deps.owner,
      repo: deps.repo,
      base: opts.tgt,
      head: opts.src,
      commit_message,
    });
    const data = (resp as { data?: { sha?: string }; status: number }).data;
    return { kind: "ok", status: resp.status, sha: data?.sha };
  } catch (err) {
    return { kind: "err", err };
  }
}

export async function mergeStep(deps: MergeStepDeps, opts: MergeStepOpts): Promise<MergeOutcome> {
  const logCtx = {
    run_id: opts.runId,
    delivery_id: opts.deliveryId,
    owner: deps.owner,
    repo: deps.repo,
    src: opts.src,
    tgt: opts.tgt,
  };

  let compare: CompareData & { ahead_by: number; base_commit: { sha: string } };
  try {
    const resp = await deps.octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
      owner: deps.owner,
      repo: deps.repo,
      basehead: `${opts.tgt}...${opts.src}`,
    });
    compare = (resp as { data: CompareData & { ahead_by: number; base_commit: { sha: string } } })
      .data;
  } catch (err) {
    const { status, message } = classifyError(err);
    const mapped = mapError("compare", status ?? 0, opts.tgt);
    if (mapped) {
      log.error(
        {
          ...logCtx,
          err,
          status,
          endpoint: "compare",
          missing_permission: mapped.missing_permission,
          event: "cascade_permission_error",
        },
        "cascade",
      );
      return {
        outcome: "permission_error",
        endpoint: "compare",
        status: status!,
        missing_permission: mapped.missing_permission,
        check_run_id: null,
      };
    }
    log.error({ ...logCtx, err, status, event: "cascade_step_unknown_error" }, "cascade");
    return { outcome: "unknown_error", status, message, check_run_id: null };
  }

  if (compare.ahead_by === 0) {
    log.info({ ...logCtx, event: "cascade_step_skipped" }, "cascade");
    return { outcome: "skipped", reason: "ahead_by_zero" };
  }

  // Protection pre-flight (OPS-04): skip Check Run + merge attempt entirely when protection blocks — fewer API calls.
  const protection = await protectionCheck(
    { octokit: deps.octokit, owner: deps.owner, repo: deps.repo, appSlug: deps.appSlug },
    opts.tgt,
  );
  if ("permission_error" in protection && protection.permission_error) {
    const mapped = mapError("branches_protection", protection.status, opts.tgt);
    await checkRun.createFailureCheckRun(
      { octokit: deps.octokit, owner: deps.owner, repo: deps.repo },
      {
        head_sha: opts.source_sha,
        name: `auto-merge: ${opts.src} → ${opts.tgt}`,
        title: `Failed ${opts.src} → ${opts.tgt}`,
        summary: mapped?.summary ?? "Cannot pre-flight branch protection",
      },
    );
    return {
      outcome: "permission_error",
      endpoint: "branches_protection",
      status: protection.status,
      missing_permission: mapped?.missing_permission ?? "administration:read",
      check_run_id: null,
    };
  }
  if ("blocked" in protection && protection.blocked) {
    return {
      outcome: "protection_blocked",
      rule: protection.rules[0]!,
      source_sha: opts.source_sha,
      check_run_id: null,
      check_run_html_url: null,
    };
  }

  const targetHeadBefore = compare.base_commit.sha;

  const cr = await checkRun.createInProgress(
    { octokit: deps.octokit, owner: deps.owner, repo: deps.repo },
    { source_sha: opts.source_sha, src: opts.src, tgt: opts.tgt, runId: opts.runId },
  );
  const check_run_id = cr?.check_run_id ?? null;
  const check_run_html_url = cr?.html_url ?? null;

  // commit_message is identical across the first merge and the stale-base retry — D-10 reuses the same params and lets GitHub recompute from new HEAD.
  const commit_message = buildCommitMessage({
    src: opts.src,
    tgt: opts.tgt,
    runId: opts.runId,
    compare,
  });

  const first = await attemptMerge(deps, opts, commit_message);

  if (first.kind === "ok") {
    if (first.status === 201 && first.sha) {
      log.info({ ...logCtx, sha: first.sha, event: "cascade_step_merged" }, "cascade");
      if (check_run_id !== null) {
        await checkRun.completeSuccess(
          { octokit: deps.octokit, owner: deps.owner, repo: deps.repo },
          { check_run_id, src: opts.src, tgt: opts.tgt, runId: opts.runId },
        );
      }
      return { outcome: "merged", sha: first.sha, check_run_id };
    }
    if (first.status === 204) {
      log.info({ ...logCtx, event: "cascade_step_skipped_204" }, "cascade");
      if (check_run_id !== null) {
        await patchCheckRunNeutral(deps, check_run_id, opts);
      }
      return { outcome: "skipped", reason: "status_204" };
    }
    // 200-range non-201/204 is not documented for Merges API; treat as unknown_error fail-closed (D-11).
    log.error({ ...logCtx, status: first.status, event: "cascade_step_unknown_error" }, "cascade");
    return {
      outcome: "unknown_error",
      status: first.status,
      message: `unexpected status ${first.status}`,
      check_run_id,
    };
  }

  const { status, message } = classifyError(first.err);

  if (status !== 409) {
    const mapped = mapError("merges", status ?? 0, opts.tgt);
    if (mapped) {
      log.error(
        {
          ...logCtx,
          err: first.err,
          status,
          endpoint: "merges",
          missing_permission: mapped.missing_permission,
          event: "cascade_permission_error",
        },
        "cascade",
      );
      return {
        outcome: "permission_error",
        endpoint: "merges",
        status: status!,
        missing_permission: mapped.missing_permission,
        check_run_id,
      };
    }
    log.error(
      { ...logCtx, err: first.err, status, event: "cascade_step_unknown_error" },
      "cascade",
    );
    return { outcome: "unknown_error", status, message, check_run_id };
  }

  // HEAD before/after structural check — locale-safe vs substring on err.message; one retry max per D-10.
  let targetHeadAfter: string;
  try {
    const branchResp = await deps.octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", {
      owner: deps.owner,
      repo: deps.repo,
      branch: opts.tgt,
    });
    targetHeadAfter = (branchResp as { data: { commit: { sha: string } } }).data.commit.sha;
  } catch (err) {
    const cls = classifyError(err);
    const mapped = mapError("branches", cls.status ?? 0, opts.tgt);
    if (mapped) {
      log.error(
        {
          ...logCtx,
          err,
          status: cls.status,
          endpoint: "branches",
          missing_permission: mapped.missing_permission,
          event: "cascade_permission_error",
        },
        "cascade",
      );
      return {
        outcome: "permission_error",
        endpoint: "branches",
        status: cls.status!,
        missing_permission: mapped.missing_permission,
        check_run_id,
      };
    }
    log.error({ ...logCtx, err, event: "cascade_step_unknown_error" }, "cascade");
    return {
      outcome: "unknown_error",
      status: cls.status,
      message: cls.message,
      check_run_id,
    };
  }

  if (targetHeadBefore === targetHeadAfter) {
    log.info({ ...logCtx, event: "cascade_step_conflict" }, "cascade");
    return {
      outcome: "conflict",
      source_sha: opts.source_sha,
      check_run_id,
      check_run_html_url,
    };
  }

  log.info(
    {
      ...logCtx,
      before: targetHeadBefore,
      after: targetHeadAfter,
      event: "cascade_step_stale_retry",
    },
    "cascade",
  );

  const retry = await attemptMerge(deps, opts, commit_message);
  if (retry.kind === "ok") {
    if (retry.status === 201 && retry.sha) {
      log.info(
        { ...logCtx, sha: retry.sha, event: "cascade_step_stale_retry_succeeded" },
        "cascade",
      );
      if (check_run_id !== null) {
        await checkRun.completeSuccess(
          { octokit: deps.octokit, owner: deps.owner, repo: deps.repo },
          { check_run_id, src: opts.src, tgt: opts.tgt, runId: opts.runId },
        );
      }
      return { outcome: "merged", sha: retry.sha, check_run_id };
    }
    if (retry.status === 204) {
      log.info({ ...logCtx, event: "cascade_step_skipped_204" }, "cascade");
      if (check_run_id !== null) {
        await patchCheckRunNeutral(deps, check_run_id, opts);
      }
      return { outcome: "skipped", reason: "status_204" };
    }
    log.error({ ...logCtx, status: retry.status, event: "cascade_step_unknown_error" }, "cascade");
    return {
      outcome: "unknown_error",
      status: retry.status,
      message: `unexpected status ${retry.status}`,
      check_run_id,
    };
  }

  const retryCls = classifyError(retry.err);
  if (retryCls.status === 409) {
    log.info({ ...logCtx, event: "cascade_step_conflict" }, "cascade");
    return {
      outcome: "conflict",
      source_sha: opts.source_sha,
      check_run_id,
      check_run_html_url,
    };
  }

  const retryMapped = mapError("merges", retryCls.status ?? 0, opts.tgt);
  if (retryMapped) {
    log.error(
      {
        ...logCtx,
        err: retry.err,
        status: retryCls.status,
        endpoint: "merges",
        missing_permission: retryMapped.missing_permission,
        event: "cascade_permission_error",
      },
      "cascade",
    );
    return {
      outcome: "permission_error",
      endpoint: "merges",
      status: retryCls.status!,
      missing_permission: retryMapped.missing_permission,
      check_run_id,
    };
  }

  log.error(
    { ...logCtx, err: retry.err, status: retryCls.status, event: "cascade_step_unknown_error" },
    "cascade",
  );
  return {
    outcome: "unknown_error",
    status: retryCls.status,
    message: retryCls.message,
    check_run_id,
  };
}
