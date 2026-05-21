import type { FastifyInstance } from "fastify";
import { attachWebhookErrorRedactor, createProbot, initBotIdentity, readyzCheck } from "./auth.js";
import { type CascadeJob, runCascade } from "./cascade/orchestrator.js";
import { startCron } from "./cron/safetyNet.js";
import { loadEnv } from "./env.js";
import { initLogger } from "./log.js";
import { NoopChannel } from "./notify/channel.js";
import { buildServer } from "./server.js";
import { dedup } from "./webhook/dedup.js";
import { createMultiQueue } from "./webhook/multiQueue.js";

const env = loadEnv();
const appLog = initLogger(env);

let app: FastifyInstance | undefined;
let multiQueue: ReturnType<typeof createMultiQueue<CascadeJob>> | undefined;
// cronHandle stored at module scope so 03-07 shutdown handler can call cronHandle?.stop() before drain.
let cronHandle: { stop: () => Promise<void> } | undefined;

try {
  const probot = createProbot(env);

  // Probot 14 initialises .webhooks asynchronously — must await before webhooks are usable (D-23)
  await probot.ready();
  await initBotIdentity(env);
  attachWebhookErrorRedactor(probot);

  multiQueue = createMultiQueue<CascadeJob>({
    perKeyMax: env.WEBHOOK_QUEUE_PER_KEY_MAX,
    globalMax: env.WEBHOOK_QUEUE_MAX,
    handler: runCascade,
    notify: new NoopChannel(),
  });

  cronHandle = await startCron({ env, multiQueue, log: appLog });

  app = await buildServer({
    env,
    log: appLog,
    readyzFn: readyzCheck,
    probot,
    dedup,
    queue: multiQueue,
  });
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  appLog.info({ port: env.PORT }, "listening");
} catch (e) {
  appLog.fatal({ err: e }, "boot-failed");
  process.exit(1);
}

// Guards against double-shutdown when the container runtime delivers SIGTERM twice.
let shuttingDown = false;

export const shutdown = async (sig: string) => {
  if (shuttingDown) {
    // Idempotency: log and bail so cronHandle.stop / drain are not called twice.
    appLog.warn({ sig, event: "shutdown_already_in_progress" }, "shutdown");
    return;
  }
  shuttingDown = true;
  appLog.info({ sig, event: "shutdown_start" }, "shutdown");
  try {
    // D-18: stop cron first so no new jobs enter the queue while we drain.
    if (cronHandle) await cronHandle.stop();
    // Close Fastify so no new webhook jobs are accepted before drain.
    await app?.close();
    // Drain outstanding cascade jobs; timeout exits 0 per D-19 (not an error).
    if (multiQueue) await multiQueue.drain(env.SHUTDOWN_TIMEOUT);
    appLog.info({ event: "shutdown_clean" }, "shutdown");
    process.exit(0);
  } catch (e) {
    // Exit 1 so k8s restarts the pod rather than leaving a non-processing zombie.
    appLog.error({ err: e, event: "shutdown_error" }, "shutdown");
    process.exit(1);
  }
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
