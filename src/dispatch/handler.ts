import type { Probot } from "probot";
import type { CascadeJob } from "../cascade/orchestrator.js";
import { log } from "../log.js";
import { buildKey, type MultiQueue } from "../webhook/multiQueue.js";

export interface DispatchHandlerDeps {
  queue: MultiQueue<CascadeJob>;
}

interface DispatchPayloadShape {
  action: string;
  // Ignored: GitHub resolves this to the repo default branch, not a user-controllable target. Source is always config.main_branch HEAD.
  branch: string;
  client_payload: Record<string, unknown> | null;
  sender: { login: string };
  installation?: { id: number } | null;
  repository: { name: string; owner: { login: string } };
}

interface DispatchContext {
  id: string;
  payload: DispatchPayloadShape;
}

export async function handleDispatchEvent(
  ctx: DispatchContext,
  deps: DispatchHandlerDeps,
): Promise<void> {
  const { payload } = ctx;
  const delivery_id = ctx.id;

  // Filter: only 'auto-merge' is ours; other apps may share the repository_dispatch channel.
  if (payload.action !== "auto-merge") {
    log.info({ delivery_id, action: payload.action, event: "dispatch_skipped" }, "dispatch");
    return;
  }

  // Defensive guard: installation.id is required to mint an installation token in the orchestrator.
  if (!payload.installation?.id) {
    log.warn({ delivery_id, event: "dispatch_missing_installation" }, "dispatch");
    return;
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const installation_id = payload.installation.id;

  // No loop-prevention or pre-enqueue dedup: dispatch comes from GITHUB_TOKEN (not bot); dedup runs post-SHA-resolve in orchestrator.

  const job: Extract<CascadeJob, { source: "dispatch" }> = {
    source: "dispatch",
    installation_id,
    owner,
    repo,
    after: null,
    sender: { login: payload.sender.login },
  };

  deps.queue.enqueue(buildKey(job), { id: delivery_id, payload: job });

  // client_payload logged verbatim for audit: operator needs full context on who triggered the cascade.
  log.info(
    {
      delivery_id,
      owner,
      repo,
      action: payload.action,
      sender_login: payload.sender.login,
      client_payload: payload.client_payload,
      event: "dispatch_received",
    },
    "dispatch",
  );
}

// Separate registration from logic for testability — mirrors registerPushHandler shape.
export function registerDispatchHandler(probot: Probot, deps: DispatchHandlerDeps): void {
  probot.on("repository_dispatch", async (ctx) => {
    await handleDispatchEvent(ctx as unknown as DispatchContext, deps);
  });
}
