import { createAppAuth } from "@octokit/auth-app";
import { Probot } from "probot";
import type { Env } from "./env.js";
import { log } from "./log.js";

export function attachWebhookErrorRedactor(probot: Probot): void {
  probot.webhooks.onError((err) => {
    const inner =
      err instanceof AggregateError ? (err.errors[0] as Error) : err;
    const isSigMismatch = inner?.message?.includes("signature does not match");
    log.warn(
      {
        kind: isSigMismatch ? "signature-mismatch" : "webhook-error",
        msg: inner?.message,
      },
      "webhook-rejected",
    );
  });
}

// Probot's appAuth is not directly reachable; we mint our own for /readyz JWT signing.
let appAuth: ReturnType<typeof createAppAuth> | undefined;

export function createProbot(env: Env): Probot {
  const probot = new Probot({
    appId: env.APP_ID,
    privateKey: env.PRIVATE_KEY,
    secret: env.WEBHOOK_SECRET,
    log,
  });

  appAuth = createAppAuth({
    appId: env.APP_ID,
    privateKey: env.PRIVATE_KEY,
  });

  return probot;
}

// auth({type:"app"}) signs a JWT locally without network; skipping installation token avoids racing install-events on rolling restart (D-08, D-09).
export async function readyzCheck(): Promise<{ ok: boolean; reason?: string }> {
  if (!appAuth) {
    return { ok: false, reason: "auth-not-initialised" };
  }

  try {
    const { token, expiresAt } = await appAuth({ type: "app" });
    if (!token || new Date(expiresAt).getTime() < Date.now()) {
      return { ok: false, reason: "jwt-expired" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
