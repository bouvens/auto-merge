import type { Octokit } from "@octokit/core";
import type { Env } from "../env.js";
import { log } from "../log.js";
import { notifySlackEnv, notifyTelegramEnv } from "./envNotify.js";
import { type OnboardArgs, type OnboardOutcome, onboardRepo } from "./onboardRepo.js";
import pLimit from "./pLimit.js";
import { markOnboarding } from "./suppressionSet.js";

export interface OnboardingHandlerDeps {
  octokitFactory: (installationId: number) => Promise<InstanceType<typeof Octokit> | undefined>;
  multiQueue: { clearByInstallation(id: number): number };
  env: Pick<
    Env,
    | "SLACK_WEBHOOK_URL"
    | "TELEGRAM_BOT_TOKEN"
    | "TELEGRAM_DEFAULT_CHAT_ID"
    | "NOTIFY_TIMEOUT_MS"
    | "SETUP_PUBLIC_URL"
  >;
}

export interface OnboardingHandlers {
  onInstallation(ctx: { payload: unknown; id?: string }): Promise<void>;
  onRepositoriesAdded(ctx: { payload: unknown; id?: string }): Promise<void>;
  onInstallationDeleted(ctx: { payload: unknown; id?: string }): Promise<void>;
}

interface RepoRef {
  owner: string;
  repo: string;
  fullName: string;
}

interface RepoEntry {
  name?: string;
  full_name?: string;
}

interface SenderShape {
  login?: string;
  type?: string;
}

function extractRepos(
  payload: unknown,
  fields: Array<"repositories" | "repositories_added">,
): RepoRef[] {
  const p = payload as Record<string, unknown> | null;
  if (!p) return [];
  let raw: unknown;
  for (const field of fields) {
    if (Array.isArray(p[field])) {
      raw = p[field];
      break;
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: RepoRef[] = [];
  for (const item of raw as RepoEntry[]) {
    const fullName = item?.full_name;
    if (typeof fullName !== "string") continue;
    const slash = fullName.indexOf("/");
    if (slash <= 0 || slash === fullName.length - 1) continue;
    out.push({
      owner: fullName.slice(0, slash),
      repo: fullName.slice(slash + 1),
      fullName,
    });
  }
  return out;
}

function extractSender(payload: unknown): string | undefined {
  const p = payload as { sender?: SenderShape } | null;
  const sender = p?.sender;
  if (!sender || sender.type !== "User" || typeof sender.login !== "string") return undefined;
  return sender.login;
}

function extractInstallationId(payload: unknown): number | undefined {
  const p = payload as { installation?: { id?: number } } | null;
  const id = p?.installation?.id;
  return typeof id === "number" ? id : undefined;
}

function extractRepositorySelection(payload: unknown): string | undefined {
  const p = payload as {
    repository_selection?: string;
    installation?: { repository_selection?: string };
  } | null;
  return p?.repository_selection ?? p?.installation?.repository_selection;
}

function buildAggregateSummaryText(
  outcomes: OnboardOutcome[],
  installationId: number,
): string | null {
  const bad = outcomes.filter((o) => o.status === "protection_blocked" || o.status === "failed");
  if (bad.length === 0) return null;
  const lines = bad.map((o) => {
    if (o.status === "protection_blocked") return `- ${o.owner}/${o.repo} (protection_blocked)`;
    return `- ${o.owner}/${o.repo} (failed: ${o.step})`;
  });
  return `auto-merge onboarding (installation ${installationId}): ${bad.length} repo${bad.length === 1 ? "" : "s"} need manual attention:\n${lines.join("\n")}`;
}

export function createOnboardingHandlers(deps: OnboardingHandlerDeps): OnboardingHandlers {
  async function runBatch(
    installationId: number,
    repos: RepoRef[],
    senderLogin: string | undefined,
  ): Promise<void> {
    // D-03: per-batch semaphore — each webhook delivery owns its own concurrency budget.
    const limit = pLimit(2);

    const outcomes = await Promise.all(
      repos.map((r) =>
        limit(async (): Promise<OnboardOutcome> => {
          const args: OnboardArgs = {
            installationId,
            owner: r.owner,
            repo: r.repo,
            senderLogin,
            publicUrl: deps.env.SETUP_PUBLIC_URL,
            octokitFactory: deps.octokitFactory,
          };
          try {
            return await onboardRepo(args);
          } catch (err) {
            log.warn(
              { err, owner: r.owner, repo: r.repo, event: "onboard_repo_unhandled" },
              "onboarding",
            );
            return {
              status: "failed",
              owner: r.owner,
              repo: r.repo,
              step: "unhandled",
              err_message: String(err),
            };
          }
        }),
      ),
    );

    let created = 0;
    let skipped = 0;
    let blocked = 0;
    let failed = 0;
    for (const o of outcomes) {
      if (o.status === "created") created++;
      else if (o.status === "skipped") skipped++;
      else if (o.status === "protection_blocked") blocked++;
      else if (
        o.status === "failed" ||
        o.status === "permission_denied" ||
        o.status === "token_mint_failed"
      )
        failed++;
    }
    log.info(
      {
        event: "onboard_batch_complete",
        installation_id: installationId,
        total: repos.length,
        created,
        skipped,
        blocked,
        failed,
      },
      "onboarding",
    );

    const summary = buildAggregateSummaryText(outcomes, installationId);
    if (summary) {
      await notifySlackEnv(deps, summary);
      await notifyTelegramEnv(deps, summary);
    }
  }

  return {
    async onInstallation(ctx) {
      const installationId = extractInstallationId(ctx.payload);
      if (installationId === undefined) {
        log.warn({ event: "onboard_payload_missing_installation_id" }, "onboarding");
        return;
      }
      markOnboarding(installationId);

      const repos = extractRepos(ctx.payload, ["repositories"]);
      const senderLogin = extractSender(ctx.payload);
      const selection = extractRepositorySelection(ctx.payload);

      // Pitfall 2: repository_selection='all' arrives without a repositories list — we cannot fan out without an extra list call, so we skip and surface a warning.
      if (repos.length === 0 && selection === "all") {
        log.info(
          { event: "onboard_skipped_all_repos_no_list", installation_id: installationId },
          "onboarding",
        );
        return;
      }
      if (repos.length === 0) {
        log.info({ event: "onboard_batch_empty", installation_id: installationId }, "onboarding");
        return;
      }

      // D-04: return immediately; Probot must ACK within 10s and bulk-install batch can take minutes.
      void runBatch(installationId, repos, senderLogin).catch((err) =>
        log.error(
          { err, installation_id: installationId, event: "onboard_batch_unhandled" },
          "onboarding",
        ),
      );
    },

    async onRepositoriesAdded(ctx) {
      const installationId = extractInstallationId(ctx.payload);
      if (installationId === undefined) {
        log.warn({ event: "onboard_payload_missing_installation_id" }, "onboarding");
        return;
      }
      markOnboarding(installationId);

      const repos = extractRepos(ctx.payload, ["repositories_added"]);
      const senderLogin = extractSender(ctx.payload);

      if (repos.length === 0) {
        log.info({ event: "onboard_batch_empty", installation_id: installationId }, "onboarding");
        return;
      }

      // D-04: return immediately; Probot must ACK within 10s and bulk-install batch can take minutes.
      void runBatch(installationId, repos, senderLogin).catch((err) =>
        log.error(
          { err, installation_id: installationId, event: "onboard_batch_unhandled" },
          "onboarding",
        ),
      );
    },

    async onInstallationDeleted(ctx) {
      const installationId = extractInstallationId(ctx.payload);
      if (installationId === undefined) {
        log.warn({ event: "onboard_payload_missing_installation_id" }, "onboarding");
        return;
      }
      const dropped = deps.multiQueue.clearByInstallation(installationId);
      log.info(
        {
          event: "onboard_installation_cleaned",
          installation_id: installationId,
          lanes_dropped: dropped,
        },
        "onboarding",
      );
    },
  };
}
