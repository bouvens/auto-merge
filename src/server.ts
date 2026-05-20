import Fastify from "fastify";
import rawBodyPlugin from "fastify-raw-body";
import type pino from "pino";
import type { Probot } from "probot";
import type { Env } from "./env.js";

export interface BuildServerDeps {
  env: Env;
  log: pino.Logger;
  // Optional: wired by index.ts after probot.ready(); absence → 503 "readyz-not-wired"
  readyzFn?: () => Promise<{ ok: boolean; reason?: string }>;
  // Optional: Plan 05 will use this to register /webhook route
  probot?: Probot;
}

export async function buildServer(deps: BuildServerDeps) {
  // logger:false — we bring our own pino instance; Fastify's built-in logger would duplicate output
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  // global:false — only routes opting-in via config.rawBody:true incur raw-capture overhead; health routes are exempt
  await app.register(rawBodyPlugin, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
  });

  // Liveness probe: always 200 while the event loop is alive (D-11) — no I/O, no auth check
  app.get("/healthz", async () => ({ status: "ok" }));

  // Readiness probe: reflects JWT-mint health; 503 when no check is wired keeps k8s from routing traffic too early
  app.get("/readyz", async (_req, reply) => {
    if (!deps.readyzFn) {
      return reply.code(503).send({ status: "not-ready", reason: "readyz-not-wired" });
    }

    const result = await deps.readyzFn();

    if (!result.ok) {
      return reply.code(503).send({ status: "not-ready", reason: result.reason });
    }

    return { status: "ready" };
  });

  return app;
}
