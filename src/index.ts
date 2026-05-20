import type { FastifyInstance } from "fastify";
import { createProbot, readyzCheck } from "./auth.js";
import { loadEnv } from "./env.js";
import { initLogger, log } from "./log.js";
import { buildServer } from "./server.js";
import { dedup } from "./webhook/dedup.js";
import { createQueue } from "./webhook/queue.js";

const env = loadEnv();
const appLog = initLogger(env);

let app: FastifyInstance | undefined;
let queue: ReturnType<typeof createQueue<{ name: string }>> | undefined;

try {
  const probot = createProbot(env);

  // Probot 14 initialises .webhooks asynchronously — must await before webhooks are usable (D-23)
  await probot.ready();

  queue = createQueue<{ name: string }>({
    max: env.WEBHOOK_QUEUE_MAX,
    handler: async (job) => {
      log.info({ delivery_id: job.id, name: job.payload.name }, "cascade-placeholder");
    },
  });

  app = await buildServer({ env, log: appLog, readyzFn: readyzCheck, probot, dedup, queue });
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  appLog.info({ port: env.PORT }, "listening");
} catch (e) {
  appLog.fatal({ err: e }, "boot-failed");
  process.exit(1);
}

const shutdown = async (sig: string) => {
  appLog.info({ sig }, "shutdown-start");
  try {
    await app?.close();
    if (queue) {
      await queue.drain(env.SHUTDOWN_TIMEOUT);
    }
    appLog.info("shutdown-clean");
    process.exit(0);
  } catch (e) {
    appLog.error({ err: e }, "shutdown-error");
    process.exit(1);
  }
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
