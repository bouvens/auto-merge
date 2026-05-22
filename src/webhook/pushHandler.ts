import type { Probot } from "probot";
import { getBotIdentity } from "../auth.js";
import { checkLoop } from "../cascade/loopPrevention.js";
import type { CascadeJob, PushJob } from "../cascade/orchestrator.js";
import { sourceShaDedup } from "../cascade/sourceShaDedup.js";
import { loadConfig } from "../config/loader.js";
import { log } from "../log.js";
import type { NotificationChannel } from "../notify/channel.js";
import { buildKey, type MultiQueue } from "./multiQueue.js";

export interface PushHandlerDeps {
  queue: MultiQueue<CascadeJob>;
  // D-01: notify is forwarded into loadConfig so push-path invalid configs reach Slack/Telegram (cron/dispatch path already does this)
  notify: NotificationChannel;
}

interface PushPayloadShape {
  ref: string;
  created: boolean;
  deleted: boolean;
  before: string;
  after: string;
  installation?: { id: number } | null;
  sender: { login: string };
  repository: { name: string; owner: { login: string } };
  head_commit: {
    id: string;
    message: string;
    author: { name?: string; email: string; username?: string | null };
  } | null;
}

interface PushContext {
  id: string;
  payload: PushPayloadShape;
  octokit: Parameters<typeof loadConfig>[0]["octokit"];
}

const REFS_HEADS = "refs/heads/";

export async function handlePushEvent(ctx: PushContext, deps: PushHandlerDeps): Promise<void> {
  const { payload } = ctx;
  const delivery_id = ctx.id;

  if (!payload.ref.startsWith(REFS_HEADS)) return;
  if (payload.created || payload.deleted) return;
  if (!payload.head_commit) return;
  if (!payload.installation?.id) return;

  const branch = payload.ref.slice(REFS_HEADS.length);
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const after = payload.after;

  const { config, errors } = await loadConfig({
    octokit: ctx.octokit,
    owner,
    repo,
    sha: after,
    installation_id: payload.installation.id,
    notify: deps.notify,
  });
  if (errors.length > 0 || !config) {
    log.warn({ delivery_id, owner, repo, event: "push_config_invalid" }, "push");
    return;
  }

  if (branch !== config.main_branch && branch !== config.release_branch) return;

  const bot = getBotIdentity();
  const loop = checkLoop(
    { sender: { login: payload.sender.login }, head_commit: payload.head_commit },
    bot,
  );
  if (loop.skip) {
    log.info(
      {
        delivery_id,
        owner,
        repo,
        branch,
        reasons: loop.reasons,
        event: "cascade_skipped_loop_prevention",
      },
      "push",
    );
    return;
  }

  const dedupKey = `${owner}/${repo}@${after}`;
  if (sourceShaDedup.seen(dedupKey)) {
    log.info(
      { delivery_id, owner, repo, source_sha: after, event: "cascade_skipped_dedup" },
      "push",
    );
    return;
  }
  sourceShaDedup.mark(dedupKey);

  const job: PushJob = {
    source: "push",
    installation_id: payload.installation.id,
    owner,
    repo,
    branch,
    after,
    before: payload.before,
    sender_login: payload.sender.login,
    head_commit: {
      id: payload.head_commit.id,
      message: payload.head_commit.message,
      author: {
        name: payload.head_commit.author.name,
        email: payload.head_commit.author.email,
        username: payload.head_commit.author.username,
      },
    },
    config,
  };

  deps.queue.enqueue(buildKey(job), { id: delivery_id, payload: job });
  log.info({ delivery_id, owner, repo, branch, source_sha: after, event: "push_enqueued" }, "push");
}

// Separate registration from log-only lifecycle handlers — cleanly isolates the cascade-enqueue path.
export function registerPushHandler(probot: Probot, deps: PushHandlerDeps): void {
  probot.on("push", async (ctx) => {
    await handlePushEvent(ctx as unknown as PushContext, deps);
  });
}
