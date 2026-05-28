import { mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  attachWebhookErrorRedactor,
  createProbot,
  getAppOctokit,
  getInstallationOctokit,
  initBotIdentity,
  readyzCheck,
} from "./auth.js";
import { type CascadeJob, makeRunCascade } from "./cascade/orchestrator.js";
import { initDefaultConfigLoader, stopDefaultConfigLoader } from "./config/defaultLoader.js";
import { getRepoConfig } from "./config/loader.js";
import { startCron } from "./cron/safetyNet.js";
import { loadEnv } from "./env.js";
import { initLogger } from "./log.js";
import type { NotificationChannel } from "./notify/channel.js";
import { MultiChannel } from "./notify/dispatcher.js";
import { createNotifyHealthChecker, type NotifyStatus } from "./notify/healthCheck.js";
import { SlackChannel } from "./notify/slack.js";
import { TelegramChannel } from "./notify/telegram.js";
import { createOnboardingHandlers } from "./onboarding/handler.js";
import { isOnboarding } from "./onboarding/suppressionSet.js";
import { getInstallationOctokitWithRetry } from "./onboarding/tokenRetry.js";
import { buildServer } from "./server.js";
import {
  type CredentialsStore,
  checkStaleOnBoot,
  createCredentialsStore,
} from "./setup/credentials.js";
import { makeShutdown } from "./shutdown.js";
import { dedup } from "./webhook/dedup.js";
import { createMultiQueue } from "./webhook/multiQueue.js";

const env = loadEnv();
const appLog = initLogger(env);

let credentialsStore: CredentialsStore | undefined;
if (env.SETUP_ENABLED) {
  mkdirSync(env.SETUP_OUTPUT_DIR, { recursive: true });
  checkStaleOnBoot(env.SETUP_OUTPUT_DIR, appLog);
  credentialsStore = createCredentialsStore({ dir: env.SETUP_OUTPUT_DIR, log: appLog });
}

let app: FastifyInstance | undefined;
let multiQueue: ReturnType<typeof createMultiQueue<CascadeJob>> | undefined;
let cronHandle: { stop: () => Promise<void> } | undefined;

try {
  if (env._setupOnly) {
    appLog.info(
      { mode: "setup-only", setup_url: env.SETUP_PUBLIC_URL },
      "boot — credentials missing; serving /setup/* only until manifest flow completes",
    );

    const healthChecker = createNotifyHealthChecker(env);
    app = await buildServer({
      env,
      log: appLog,
      // Setup-only readyz never reaches "ready" — k8s should not route webhooks here yet.
      readyzFn: async () => ({ ok: false, reason: "setup-only-mode" }),
      credentials: credentialsStore,
      healthChecker,
    });
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    appLog.info({ port: env.PORT, mode: "setup-only" }, "listening");
  } else {
    initDefaultConfigLoader(env, appLog);

    const probot = createProbot(env);
    // Probot 14 initialises .webhooks asynchronously (D-23).
    await probot.ready();
    await initBotIdentity(env);
    attachWebhookErrorRedactor(probot);

    const channels: NotificationChannel[] = [];
    if (env.SLACK_WEBHOOK_URL) {
      channels.push(
        new SlackChannel({
          webhookUrl: env.SLACK_WEBHOOK_URL,
          env,
          getConfig: (repo) => {
            const [owner, repoName] = repo.split("/");
            return getRepoConfig(owner ?? "", repoName ?? "");
          },
        }),
      );
    }
    if (env.TELEGRAM_BOT_TOKEN) {
      channels.push(
        new TelegramChannel({
          botToken: env.TELEGRAM_BOT_TOKEN,
          env,
          getConfig: (repo) => {
            const [owner, repoName] = repo.split("/");
            return getRepoConfig(owner ?? "", repoName ?? "");
          },
        }),
      );
    }
    const notify = new MultiChannel(channels, { suppressionCheck: (id) => isOnboarding(id) });

    multiQueue = createMultiQueue<CascadeJob>({
      perKeyMax: env.WEBHOOK_QUEUE_PER_KEY_MAX,
      globalMax: env.WEBHOOK_QUEUE_MAX,
      handler: makeRunCascade({ notify }),
      notify,
    });

    const onboarding = createOnboardingHandlers({
      octokitFactory: getInstallationOctokitWithRetry,
      multiQueue,
      env,
    });

    cronHandle = await startCron({ env, multiQueue, log: appLog });

    const healthChecker = createNotifyHealthChecker(env);
    const notifyHealthy = (s: NotifyStatus): boolean => s === "ok" || s === "n/a";
    const wrappedReadyz = async (): Promise<{
      ok: boolean;
      reason?: string;
      body?: Record<string, unknown>;
    }> => {
      const auth = await readyzCheck();
      const notify = healthChecker.getStatus();
      const strict = env.NOTIFY_HEALTHCHECK_REQUIRED;
      const notifyOk = !strict || (notifyHealthy(notify.slack) && notifyHealthy(notify.telegram));
      return {
        ok: auth.ok && notifyOk,
        reason: !auth.ok ? auth.reason : !notifyOk ? "notify-unreachable" : undefined,
        body: { notify_status: notify },
      };
    };

    app = await buildServer({
      env,
      log: appLog,
      readyzFn: wrappedReadyz,
      probot,
      dedup,
      queue: multiQueue,
      notify,
      onboarding,
      credentials: credentialsStore,
      healthChecker,
      getAppOctokit,
      getInstallationOctokit,
    });
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    // AFTER listen so 3s × N probes never delay readiness for k8s rolling restart.
    void healthChecker.refresh();
    appLog.info({ port: env.PORT }, "listening");
  }
} catch (e) {
  appLog.fatal({ err: e }, "boot-failed");
  process.exit(1);
}

const shutdown = makeShutdown({
  app,
  cronHandle,
  multiQueue,
  defaultLoaderStop: stopDefaultConfigLoader,
  log: appLog,
  shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT,
});

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
