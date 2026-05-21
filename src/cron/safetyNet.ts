import { randomUUID } from "node:crypto";
import type pino from "pino";
import { Cron } from "croner";
import { getAppOctokit, getInstallationOctokit } from "../auth.js";
import type { Env } from "../env.js";
import { log as defaultLog } from "../log.js";
import type { CascadeJob } from "../cascade/orchestrator.js";
import { buildKey, type MultiQueue } from "../webhook/multiQueue.js";

type AppInstallation = {
  id: number;
  suspended_at: string | null;
  account: { login: string } | null;
};

type InstallationRepo = {
  name: string;
  full_name: string;
  owner: { login: string };
};

/** Paginates GET /app/installations via app-JWT Octokit. */
async function* listAllInstallations(
  octokit: ReturnType<typeof getAppOctokit>,
): AsyncGenerator<AppInstallation> {
  let page = 1;
  while (true) {
    const resp = await octokit.request("GET /app/installations", {
      per_page: 100,
      page,
    });
    const items = resp.data as AppInstallation[];
    for (const item of items) yield item;
    if (items.length < 100) break;
    page += 1;
  }
}

/** Paginates GET /installation/repositories via installation-scoped Octokit. */
async function* listAllRepos(
  octokit: Awaited<ReturnType<typeof getInstallationOctokit>>,
): AsyncGenerator<InstallationRepo> {
  let page = 1;
  while (true) {
    const resp = await octokit.request("GET /installation/repositories", {
      per_page: 100,
      page,
    });
    const data = resp.data as { repositories: InstallationRepo[] };
    for (const repo of data.repositories) yield repo;
    if (data.repositories.length < 100) break;
    page += 1;
  }
}

/**
 * Runs one full sweep: enumerate installations via app-JWT, then enumerate repos
 * per installation via installation token, enqueue a cron CascadeJob for each.
 *
 * Exported separately so unit tests can drive the tick body without a real croner instance.
 */
export async function runCronTick(deps: {
  multiQueue: MultiQueue<CascadeJob>;
  log?: pino.Logger;
}): Promise<{ installations: number; repos_scanned: number; jobs_enqueued: number }> {
  const log = deps.log ?? defaultLog;
  const runId = randomUUID();

  log.info({ event: "cron_tick_started", run_id: runId }, "cron");

  let installations = 0;
  let repos_scanned = 0;
  let jobs_enqueued = 0;

  const appOctokit = getAppOctokit();

  for await (const inst of listAllInstallations(appOctokit)) {
    if (inst.suspended_at !== null && inst.suspended_at !== undefined) {
      // Suspended installations have their token revoked — skip to avoid a 403 on mint.
      log.debug(
        { event: "cron_inst_suspended_skipped", installation_id: inst.id },
        "cron",
      );
      continue;
    }

    installations += 1;

    let instOctokit: Awaited<ReturnType<typeof getInstallationOctokit>>;
    try {
      instOctokit = await getInstallationOctokit(inst.id);
    } catch (err) {
      // One bad installation must not abort the whole sweep.
      log.warn(
        { event: "cron_installation_repos_failed", installation_id: inst.id, err },
        "cron",
      );
      continue;
    }

    try {
      for await (const repo of listAllRepos(instOctokit)) {
        repos_scanned += 1;

        const job: CascadeJob = {
          source: "cron",
          installation_id: inst.id,
          owner: repo.owner.login,
          repo: repo.name,
          after: null,
        };

        const jobId = `cron:${runId}:${inst.id}:${repo.full_name}`;
        deps.multiQueue.enqueue(buildKey(job), { id: jobId, payload: job });
        jobs_enqueued += 1;
      }
    } catch (err) {
      // 401/403/404 from listReposAccessibleToInstallation — skip this installation, continue with the rest.
      log.warn(
        { event: "cron_installation_repos_failed", installation_id: inst.id, err },
        "cron",
      );
    }
  }

  // 0 installations is not unusual (App installed on 0 repos) — debug not warn to avoid alert fatigue (D-07).
  if (installations === 0) {
    log.debug(
      { event: "cron_tick_completed", run_id: runId, installations, repos_scanned, jobs_enqueued },
      "cron",
    );
  } else {
    log.info(
      { event: "cron_tick_completed", run_id: runId, installations, repos_scanned, jobs_enqueued },
      "cron",
    );
  }

  return { installations, repos_scanned, jobs_enqueued };
}

/**
 * Polls cron.isBusy() until the current tick completes or the timeout expires.
 * croner's .stop() is fire-and-forget — it only prevents future scheduling, not the running tick.
 */
export async function stopCronGracefully(cron: Cron, ms = 5000): Promise<void> {
  cron.stop();
  if (!cron.isBusy()) {
    defaultLog.info({ event: "shutdown_cron_stopped", forced: false }, "cron");
    return;
  }
  const start = Date.now();
  while (cron.isBusy() && Date.now() - start < ms) {
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  if (cron.isBusy()) {
    defaultLog.warn({ event: "shutdown_cron_stopped", forced: true }, "cron");
  } else {
    defaultLog.info({ event: "shutdown_cron_stopped", forced: false }, "cron");
  }
}

/**
 * Creates and starts the croner safety-net scheduler.
 *
 * Returns a handle with .stop() so the shutdown handler (03-07) can drain gracefully.
 * When CRON_SCHEDULE is empty, returns a no-op handle and logs cron_disabled (D-06).
 */
export async function startCron(deps: {
  env: Env;
  multiQueue: MultiQueue<CascadeJob>;
  log: pino.Logger;
}): Promise<{ stop: () => Promise<void> }> {
  const { env, multiQueue, log } = deps;

  if (!env.CRON_SCHEDULE) {
    log.info({ event: "cron_disabled" }, "cron");
    return { stop: async () => {} };
  }

  // protect:true makes croner skip an overlapping tick instead of stacking two concurrent sweeps.
  const cron = new Cron(
    env.CRON_SCHEDULE,
    {
      protect: true,
      timezone: env.CRON_TZ,
      name: "auto-merge-safety-net",
      catch: (err: unknown) => log.error({ err, event: "cron_tick_error" }, "cron"),
    },
    async () => {
      await runCronTick({ multiQueue, log });
    },
  );

  return {
    stop: () => stopCronGracefully(cron, 5000),
  };
}
