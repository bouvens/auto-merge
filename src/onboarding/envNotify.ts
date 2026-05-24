import type { Env } from "../env.js";
import { log } from "../log.js";

export interface EnvNotifyDeps {
  env: Pick<
    Env,
    "SLACK_WEBHOOK_URL" | "TELEGRAM_BOT_TOKEN" | "TELEGRAM_DEFAULT_CHAT_ID" | "NOTIFY_TIMEOUT_MS"
  >;
}

export async function notifySlackEnv(deps: EnvNotifyDeps, text: string): Promise<void> {
  const url = deps.env.SLACK_WEBHOOK_URL;
  if (!url) return;

  // Onboarding-time alert: swallow network failures, never crash the batch
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(deps.env.NOTIFY_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log.warn(
        { event: "onboard_envnotify_failed", channel: "slack", status: resp.status },
        "onboarding",
      );
    }
  } catch (err) {
    log.warn({ err, event: "onboard_envnotify_failed", channel: "slack" }, "onboarding");
  }
}

export async function notifyTelegramEnv(deps: EnvNotifyDeps, text: string): Promise<void> {
  const token = deps.env.TELEGRAM_BOT_TOKEN;
  const chatId = deps.env.TELEGRAM_DEFAULT_CHAT_ID;
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  // Onboarding-time alert: swallow network failures, never crash the batch
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(deps.env.NOTIFY_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log.warn(
        { event: "onboard_envnotify_failed", channel: "telegram", status: resp.status },
        "onboarding",
      );
    }
  } catch (err) {
    log.warn({ err, event: "onboard_envnotify_failed", channel: "telegram" }, "onboarding");
  }
}
