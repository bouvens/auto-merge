import type { FastifyInstance } from "fastify";
import { createProbot, readyzCheck } from "./auth.js";
import { loadEnv } from "./env.js";
import { initLogger } from "./log.js";
import { buildServer } from "./server.js";

const env = loadEnv();
const log = initLogger(env);

let app: FastifyInstance | undefined;

try {
  const probot = createProbot(env);

  // Probot 14 initialises .webhooks asynchronously — must await before webhooks are usable (D-23)
  await probot.ready();

  app = await buildServer({ env, log, readyzFn: readyzCheck, probot });
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  log.info({ port: env.PORT }, "listening");
} catch (e) {
  log.fatal({ err: e }, "boot-failed");
  process.exit(1);
}

const shutdown = async (sig: string) => {
  log.info({ sig }, "shutdown-start");
  try {
    await app?.close();
    // Queue drain wired in Plan 07 (depends on src/webhook/queue.ts from Plan 05)
    log.info("shutdown-clean");
    process.exit(0);
  } catch (e) {
    log.error({ err: e }, "shutdown-error");
    process.exit(1);
  }
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
