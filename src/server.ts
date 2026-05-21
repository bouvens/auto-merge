import Fastify from "fastify";
import rawBodyPlugin from "fastify-raw-body";
import type pino from "pino";
import type { Probot } from "probot";
import type { PushJob } from "./cascade/orchestrator.js";
import type { Env } from "./env.js";
import { log } from "./log.js";
import { registerHandlers } from "./webhook/handler.js";
import { registerPushHandler } from "./webhook/pushHandler.js";
import type { Queue } from "./webhook/queue.js";

export interface BuildServerDeps {
  env: Env;
  log: pino.Logger;
  // Optional: wired by index.ts after probot.ready(); absence → 503 "readyz-not-wired"
  readyzFn?: () => Promise<{ ok: boolean; reason?: string }>;
  // Optional: Plan 05 will use this to register /webhook route
  probot?: Probot;
  dedup?: { seen(id: string): boolean; mark(id: string): void };
  queue?: Queue<PushJob>;
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

  if (deps.probot && deps.dedup && deps.queue) {
    registerHandlers(deps.probot);
    registerPushHandler(deps.probot, { queue: deps.queue });

    const { probot, dedup } = deps;

    // config.rawBody:true opts this route into raw body capture; verifyAndReceive requires the unparsed string for HMAC.
    app.post("/webhook", { config: { rawBody: true } }, async (req, reply) => {
      const id = req.headers["x-github-delivery"] as string | undefined;
      const name = req.headers["x-github-event"] as string | undefined;
      const signature = req.headers["x-hub-signature-256"] as string | undefined;

      if (!id || !name || !signature) {
        return reply.code(400).send();
      }

      // verifyAndReceive (not receive) performs HMAC verification and fires probot.on() handlers (D-15, C-02).
      try {
        await probot.webhooks.verifyAndReceive({
          id,
          name: name as never,
          signature,
          payload: req.rawBody as string,
        });
      } catch (err) {
        // @octokit/webhooks wraps the signature-mismatch Error in an AggregateError; the inner error carries status:400
        const inner = (err instanceof AggregateError ? err.errors[0] : err) as { status?: number };
        if (inner.status === 400) {
          return reply.code(401).send();
        }
        log.error({ err, delivery_id: id }, "webhook-process-error");
        return reply.code(500).send();
      }

      // Dedup runs after HMAC verify to prevent cache poisoning by unauthenticated senders.
      if (dedup.seen(id)) {
        log.info({ delivery_id: id, event: name }, "webhook-duplicate");
        return reply.code(202).send();
      }
      dedup.mark(id);

      return reply.code(202).send();
    });
  }

  return app;
}
