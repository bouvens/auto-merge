import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { Probot } from "probot";
import type { Env } from "./env.js";
import { log } from "./log.js";

export function attachWebhookErrorRedactor(probot: Probot): void {
  probot.webhooks.onError((err) => {
    const inner = err instanceof AggregateError ? (err.errors[0] as Error) : err;
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
// Boot env cached so getInstallationOctokit can mint installation-scoped clients without re-loading env (D-30).
let bootEnv: Env | undefined;
// Bot identity resolved once at boot, used for loop-prevention in cascade engine (D-16, CASC-02).
let botIdentity: { login: string; email: string } | undefined;

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
  bootEnv = env;

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

// app.id is the App ID, NOT the bot user_id needed for the noreply email — must fetch via GET /users/{slug}[bot] (D-16, RESEARCH.md Pitfall 1).
export async function initBotIdentity(
  env: Env,
  octokitFactory?: () => InstanceType<typeof Octokit>,
): Promise<void> {
  const octokit =
    octokitFactory?.() ??
    new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: env.APP_ID, privateKey: env.PRIVATE_KEY },
    });

  const appResp = await octokit.request("GET /app");
  const slug = (appResp.data as { slug: string }).slug;
  const login = `${slug}[bot]`;

  const userResp = await octokit.request("GET /users/{username}", {
    username: login,
  });
  const botUserId = (userResp.data as { id: number }).id;

  botIdentity = {
    login,
    email: `${botUserId}+${login}@users.noreply.github.com`.toLowerCase(),
  };
}

export function getBotIdentity(): { login: string; email: string } {
  if (!botIdentity) {
    throw new Error("bot identity not initialised — call initBotIdentity at boot");
  }
  return botIdentity;
}

// Omits installationId — @octokit/auth-app signs an app-JWT for /app/* without an installation scope.
export function getAppOctokit(): InstanceType<typeof Octokit> {
  if (!bootEnv) {
    throw new Error("auth not initialised — call createProbot first");
  }
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: bootEnv.APP_ID, privateKey: bootEnv.PRIVATE_KEY },
  });
}

// per-call Octokit; @octokit/auth-app handles installation-token caching with 1h TTL (D-30, RESEARCH.md Octokit Instance Strategy).
export async function getInstallationOctokit(
  installationId: number,
): Promise<InstanceType<typeof Octokit>> {
  if (!appAuth || !bootEnv) {
    throw new Error("auth not initialised — call createProbot first");
  }
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: bootEnv.APP_ID,
      privateKey: bootEnv.PRIVATE_KEY,
      installationId,
    },
  });
}
