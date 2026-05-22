import { randomUUID } from "node:crypto";
import { getBotIdentity, getInstallationOctokit } from "../auth.js";
import type { Config } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { log } from "../log.js";
import type { NotificationChannel } from "../notify/channel.js";
import { NoopChannel } from "../notify/channel.js";
import type { Handler, Job } from "../webhook/queue.js";
import { completeFailure, createInProgress } from "./checkRun.js";
import { createConflictPR } from "./conflict.js";
import { type MergeOutcome, mergeStep } from "./merge.js";
import { buildCascadePlan } from "./plan.js";
import { sourceShaDedup } from "./sourceShaDedup.js";

export interface PushHeadCommit {
  id: string;
  message: string;
  author: { name?: string; email: string; username?: string | null };
}

type CascadeJobBase = { installation_id: number; owner: string; repo: string };

export type CascadeJob =
  | (CascadeJobBase & {
      source: "push";
      branch: string;
      after: string;
      before: string;
      sender_login: string;
      head_commit: PushHeadCommit;
      config: Config;
    })
  | (CascadeJobBase & { source: "cron"; after: null })
  | (CascadeJobBase & { source: "dispatch"; after: null; sender?: { login: string } });

// Alias preserves backward compatibility with callers that import PushJob by name.
export type PushJob = Extract<CascadeJob, { source: "push" }>;

interface ResolvedJobContext {
  after: string;
  config: Config;
  branch: string;
  headCommitAuthor: { username: string | null; email: string };
  senderLogin: string | null;
}

async function resolveJobContext(
  job: Job<CascadeJob>,
  octokit: Awaited<ReturnType<typeof getInstallationOctokit>>,
  baseLog: Record<string, unknown>,
  notify: NotificationChannel,
): Promise<ResolvedJobContext | null> {
  const payload = job.payload;

  if (payload.source === "push") {
    return {
      after: payload.after,
      config: payload.config,
      branch: payload.branch,
      headCommitAuthor: {
        username: payload.head_commit.author.username ?? null,
        email: payload.head_commit.author.email,
      },
      senderLogin: payload.sender_login,
    };
  }

  const { owner, repo } = payload;
  const { config } = await loadConfig({ octokit, owner, repo, sha: "HEAD", installation_id: payload.installation_id, notify });
  if (!config) {
    log.warn({ ...baseLog, event: "cascade_failed_config_invalid" }, "cascade");
    return null;
  }

  let resolvedSha: string;
  try {
    const branchResp = await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", {
      owner,
      repo,
      branch: config.main_branch,
    });
    resolvedSha = (branchResp as { data: { commit: { sha: string } } }).data.commit.sha;
  } catch (err) {
    log.warn({ ...baseLog, err, event: "cascade_failed" }, "cascade");
    return null;
  }

  // Dedup AFTER SHA resolve — re-firing cron/dispatch on same HEAD is a no-op.
  const dedupKey = `${owner}/${repo}@${resolvedSha}`;
  if (sourceShaDedup.seen(dedupKey)) {
    log.info(
      { ...baseLog, source_sha: resolvedSha, source: payload.source, event: "cascade_skipped_dedup" },
      "cascade",
    );
    return null;
  }
  sourceShaDedup.mark(dedupKey);

  const senderLogin = payload.source === "dispatch" ? (payload.sender?.login ?? null) : null;

  return {
    after: resolvedSha,
    config,
    branch: config.main_branch,
    headCommitAuthor: { username: null, email: "(unknown)" },
    senderLogin,
  };
}

export function makeRunCascade(deps: { notify: NotificationChannel }): Handler<CascadeJob> {
  const { notify } = deps;

  return async (job: Job<CascadeJob>): Promise<void> => {
    const { installation_id, owner, repo } = job.payload;
    const runId = randomUUID();
    const baseLog = {
      run_id: runId,
      delivery_id: job.id,
      owner,
      repo,
    };

    try {
      const octokit = await getInstallationOctokit(installation_id);

      const ctx = await resolveJobContext(job, octokit, baseLog, notify);
      if (!ctx) return;

      const { after, config, branch, headCommitAuthor, senderLogin } = ctx;

      // restrictions.apps[].slug uses the raw slug without the [bot] suffix.
      const appSlug = getBotIdentity().login.replace(/\[bot\]$/, "");

      const startLog: Record<string, unknown> = {
        ...baseLog,
        branch,
        source_sha: after,
        source: job.payload.source,
        event: "cascade_started",
      };
      if (senderLogin !== null) {
        startLog.sender_login = senderLogin;
      }
      log.info(startLog, "cascade");

      let pairs: Awaited<ReturnType<typeof buildCascadePlan>>;
      try {
        pairs = await buildCascadePlan({ octokit, owner, repo }, config, branch);
      } catch (err) {
        log.error({ ...baseLog, err, event: "cascade_failed" }, "cascade");
        return;
      }

      const outcomes: Array<{ src: string; tgt: string; outcome: MergeOutcome["outcome"] }> = [];

      for (const { src, tgt } of pairs) {
        const result = await mergeStep(
          { octokit, owner, repo, appSlug },
          { src, tgt, source_sha: after, runId, deliveryId: job.id },
        );
        outcomes.push({ src, tgt, outcome: result.outcome });

        if (result.outcome === "merged" || result.outcome === "skipped") {
          continue;
        }

        if (result.outcome === "conflict") {
          const prResult = await createConflictPR(
            { octokit, owner, repo },
            {
              src,
              tgt,
              source_sha: after,
              runId,
              checkRunHtmlUrl: result.check_run_html_url,
              headCommitAuthor,
            },
          );
          const detail = prResult.ok ? prResult.pr_url : `conflict PR failed: ${prResult.error}`;
          if (result.check_run_id !== null) {
            await completeFailure(
              { octokit, owner, repo },
              {
                check_run_id: result.check_run_id,
                src,
                tgt,
                runId,
                kind: "real_conflict",
                detail,
              },
            );
          }
          log.info(
            {
              ...baseLog,
              src,
              tgt,
              pr_url: prResult.ok ? prResult.pr_url : null,
              event: "cascade_step_conflict",
            },
            "cascade",
          );
          await notify.notify({
            kind: "cascade_conflict",
            installation_id,
            run_id: runId,
            repo: `${owner}/${repo}`,
            src,
            tgt,
            pr_url: prResult.ok ? prResult.pr_url : "",
            ...(headCommitAuthor.username ? { author_login: headCommitAuthor.username } : {}),
            ...(result.check_run_html_url ? { check_run_html_url: result.check_run_html_url } : {}),
          });
          break;
        }

        if (result.outcome === "protection_blocked") {
          const summaryPrefix = `Blocked by branch protection: ${result.rule}`;
          const prResult = await createConflictPR(
            { octokit, owner, repo },
            {
              src,
              tgt,
              source_sha: after,
              runId,
              checkRunHtmlUrl: null,
              headCommitAuthor,
              summaryPrefix,
            },
          );
          const pr_url = prResult.ok ? prResult.pr_url : "";

          // When mergeStep skipped the in_progress Check Run (protection blocked before it was created), create one now for the failure record.
          let checkRunId = result.check_run_id;
          let checkRunHtmlUrl = result.check_run_html_url;
          if (checkRunId === null) {
            const cr = await createInProgress(
              { octokit, owner, repo },
              { source_sha: after, src, tgt, runId },
            );
            checkRunId = cr?.check_run_id ?? null;
            checkRunHtmlUrl = cr?.html_url ?? null;
          }
          if (checkRunId !== null) {
            await completeFailure(
              { octokit, owner, repo },
              {
                check_run_id: checkRunId,
                src,
                tgt,
                runId,
                kind: "protection_blocked",
                detail: prResult.ok ? prResult.pr_url : summaryPrefix,
              },
            );
          }
          await notify.notify({
            kind: "protection_blocked",
            installation_id,
            run_id: runId,
            repo: `${owner}/${repo}`,
            src,
            tgt,
            pr_url,
            rule: result.rule,
            ...(headCommitAuthor.username ? { author_login: headCommitAuthor.username } : {}),
            ...(checkRunHtmlUrl ? { check_run_html_url: checkRunHtmlUrl } : {}),
          });
          break;
        }

        if (result.outcome === "permission_error") {
          if (result.check_run_id !== null) {
            await completeFailure(
              { octokit, owner, repo },
              {
                check_run_id: result.check_run_id,
                src,
                tgt,
                runId,
                kind: "permission_error",
                detail: result.missing_permission,
              },
            );
          }
          log.error(
            {
              ...baseLog,
              src,
              tgt,
              endpoint: result.endpoint,
              status: result.status,
              missing_permission: result.missing_permission,
              event: "cascade_permission_error",
            },
            "cascade",
          );
          await notify.notify({
            kind: "permission_error",
            installation_id,
            run_id: runId,
            repo: `${owner}/${repo}`,
            src,
            tgt,
            endpoint: result.endpoint,
            status: result.status,
            missing_permission: result.missing_permission,
          });
          break;
        }

        if (result.check_run_id !== null) {
          await completeFailure(
            { octokit, owner, repo },
            {
              check_run_id: result.check_run_id,
              src,
              tgt,
              runId,
              kind: "unknown_error",
              detail: `${result.status ?? "?"}: ${result.message}`,
            },
          );
        }
        log.error(
          { ...baseLog, src, tgt, status: result.status, event: "cascade_step_unknown_error" },
          "cascade",
        );
        break;
      }

      log.info({ ...baseLog, outcomes, event: "cascade_completed" }, "cascade");
    } catch (err) {
      log.error({ ...baseLog, err, event: "cascade_failed" }, "cascade");
    }
  };
}

// Backward-compatible export wired with NoopChannel; index.ts uses makeRunCascade directly.
export const runCascade: Handler<CascadeJob> = makeRunCascade({ notify: new NoopChannel() });
