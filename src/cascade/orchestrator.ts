import { randomUUID } from "node:crypto";
import { getInstallationOctokit } from "../auth.js";
import type { Config } from "../config/schema.js";
import { log } from "../log.js";
import type { Handler, Job } from "../webhook/queue.js";
import { completeFailure } from "./checkRun.js";
import { createConflictPR } from "./conflict.js";
import { type MergeOutcome, mergeStep } from "./merge.js";
import { buildCascadePlan } from "./plan.js";

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

export const runCascade: Handler<CascadeJob> = async (job: Job<CascadeJob>): Promise<void> => {
  if (job.payload.source !== "push") {
    // Stub until safetyNet/dispatch handlers land in the next plan; cron/dispatch jobs are no-ops for now.
    log.info(
      { event: "cascade_skipped_unwired", source: job.payload.source, delivery_id: job.id },
      "cascade",
    );
    return;
  }

  const { installation_id, owner, repo, branch, after, head_commit, config } = job.payload;
  // runId generated post-ACK so delivery_id and run_id remain distinct across retries.
  const runId = randomUUID();
  const baseLog = {
    run_id: runId,
    delivery_id: job.id,
    owner,
    repo,
    branch,
    source_sha: after,
  };

  log.info({ ...baseLog, event: "cascade_started" }, "cascade");

  try {
    // One Octokit per cascade run; auth-app's 1h LRU dedupes the token mint.
    const octokit = await getInstallationOctokit(installation_id);

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
        { octokit, owner, repo },
        { src, tgt, source_sha: after, runId, deliveryId: job.id },
      );
      outcomes.push({ src, tgt, outcome: result.outcome });

      // Stop on first conflict / unknown_error — downstream pairs cannot be safely merged with an unresolved upstream; merged/skipped fall through.
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
            headCommitAuthor: {
              username: head_commit.author.username,
              email: head_commit.author.email,
            },
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
    // Queue's catch logs without run_id; orchestrator's catch preserves cascade correlation.
    log.error({ ...baseLog, err, event: "cascade_failed" }, "cascade");
  }
};
