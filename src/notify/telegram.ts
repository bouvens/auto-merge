import { LRUCache } from "lru-cache";
import { log } from "../log.js";
import type { NotificationChannel, NotifyEvent } from "./channel.js";
import { formatTelegram } from "./formatters/telegram.js";
import { type RetryOpts, withRetry, HttpError } from "./retry.js";
import type { Config } from "../config/schema.js";
import type { Env } from "../env.js";

export interface TelegramChannelDeps {
  botToken: string;
  env: Pick<Env, "NOTIFY_DEDUP_TTL_MS" | "NOTIFY_DEDUP_MAX" | "NOTIFY_TIMEOUT_MS" | "NOTIFY_RETRY_ATTEMPTS">;
  getConfig: (repo: string) => Config | undefined;
}

export class TelegramError extends Error {
  constructor(
    public errorCode: number,
    public description: string,
    public retryAfterMs?: number,
  ) {
    super(`telegram ${errorCode}: ${description}`);
    this.name = "TelegramError";
  }
}

// Dedup key per event kind — run_id is a UUID per cascade run, equivalent to source_sha for collision safety.
function dedupKey(event: NotifyEvent): string {
  const k = event.kind;
  if (k === "queue_overflow") return `_:${event.key}:_:${k}:${event.dropped_id}`;
  if (k === "config_invalid") return `${event.installation_id}:${event.repo}:pre-resolve:${k}`;
  if (k === "permission_error") return `${event.installation_id}:${event.repo}:${event.endpoint}:${event.status}:${k}`;
  // cascade_conflict and protection_blocked use run_id as the uniqueness carrier.
  return `${event.installation_id}:${event.repo}:${event.run_id}:${k}`;
}

interface TelegramResponse {
  ok: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

async function sendTelegram(url: string, body: Record<string, unknown>, timeoutMs: number): Promise<void> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const json = await resp.json().catch(() => null) as TelegramResponse | null;

  if (json !== null && json.ok && resp.ok) {
    return;
  }

  const status = json?.error_code ?? resp.status;
  const description = json?.description ?? `http ${resp.status}`;
  // retry_after from Telegram is in seconds — convert to ms for HttpError.
  const retryAfterMs = json?.parameters?.retry_after ? json.parameters.retry_after * 1000 : undefined;
  throw new HttpError(status, description, retryAfterMs);
}

export class TelegramChannel implements NotificationChannel {
  private readonly dedup: LRUCache<string, true>;
  private readonly disabledRepos = new Set<string>();
  private readonly retryOpts: RetryOpts;

  constructor(private readonly deps: TelegramChannelDeps) {
    this.dedup = new LRUCache<string, true>({
      max: deps.env.NOTIFY_DEDUP_MAX,
      ttl: deps.env.NOTIFY_DEDUP_TTL_MS,
      ttlResolution: 0,
      ttlAutopurge: true,
      perf: { now: () => Date.now() },
    });
    this.retryOpts = {
      attempts: deps.env.NOTIFY_RETRY_ATTEMPTS,
      baseDelayMs: 1000,
      jitterMs: 200,
      maxRetryAfterMs: 30_000,
    };
  }

  async notify(event: NotifyEvent): Promise<void> {
    const key = dedupKey(event);
    if (this.dedup.has(key)) {
      log.debug({ event: "notify_skipped_dedup", channel: "telegram", kind: event.kind }, "notify");
      return;
    }

    const repo = "repo" in event ? event.repo : undefined;

    // queue_overflow has no repo → no chat_id fallback; skip silently.
    if (repo === undefined) {
      log.debug({ event: "notify_skipped_no_config", channel: "telegram", kind: event.kind }, "notify");
      return;
    }

    const config = this.deps.getConfig(repo);
    if (!config?.notifications?.telegram) {
      if (!this.disabledRepos.has(repo)) {
        log.info({ event: "notifications_disabled_for_repo", repo, channel: "telegram" }, "notify");
        this.disabledRepos.add(repo);
      }
      return;
    }

    const chatId = config.notifications.telegram.chat_id;
    const url = `https://api.telegram.org/bot${this.deps.botToken}/sendMessage`;
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: formatTelegram(event),
      parse_mode: "HTML",
    };

    try {
      await withRetry(() => sendTelegram(url, body, this.deps.env.NOTIFY_TIMEOUT_MS), this.retryOpts);
      this.dedup.set(key, true);
      log.debug({ event: "notify_sent", channel: "telegram", kind: event.kind, repo }, "notify");
    } catch (err) {
      log.warn({
        event: "notify_delivery_failed",
        channel: "telegram",
        kind: event.kind,
        repo,
        attempt_count: this.retryOpts.attempts,
        final_error_class: err instanceof Error ? err.name : "unknown",
        final_status: err instanceof HttpError ? err.status : undefined,
        event_payload: event,
      }, "notify");
    }
  }
}
