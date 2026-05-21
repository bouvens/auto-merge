import type { FastifyInstance } from "fastify";
import { attachWebhookErrorRedactor, createProbot, initBotIdentity, readyzCheck } from "./auth.js";
import { type CascadeJob, runCascade } from "./cascade/orchestrator.js";
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

try {
  const probot = createProbot(env);

  // Probot 14 initialises .webhooks asynchronously — must await before webhooks are usable (D-23)
  await probot.ready();
  // Bot identity must be resolved before any push webhook can fire — loop prevention fails closed without it.
  await initBotIdentity(env);
  attachWebhookErrorRedactor(probot);

  multiQueue = createMultiQueue<CascadeJob>({
    perKeyMax: env.WEBHOOK_QUEUE_PER_KEY_MAX,
    globalMax: env.WEBHOOK_QUEUE_MAX,
    handler: runCascade,
    notify: new NoopChannel(),
  });

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

const shutdown = async (sig: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  appLog.info({ sig }, "shutdown-start");
  try {
    // app.close() blocks new HTTP requests before drain so no new jobs enter the queue mid-drain.
    await app?.close();
    if (multiQueue) {
      await multiQueue.drain(env.SHUTDOWN_TIMEOUT);
    }
    appLog.info("shutdown-clean");
    process.exit(0);
  } catch (e) {
    // Exit 1 so k8s restarts the pod rather than leaving a non-processing zombie.
    appLog.error({ err: e }, "shutdown-error");
    process.exit(1);
  }
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
