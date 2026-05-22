import { LRUCache } from "lru-cache";
import type { Config } from "../config/schema.js";
import type { Env } from "../env.js";
import { log } from "../log.js";
import type { NotificationChannel, NotifyEvent } from "./channel.js";
import { formatSlack } from "./formatters/slack.js";
import { HttpError, type RetryOpts, withRetry } from "./retry.js";

export interface SlackChannelDeps {
  webhookUrl: string;
  env: Pick<
    Env,
    "NOTIFY_DEDUP_TTL_MS" | "NOTIFY_DEDUP_MAX" | "NOTIFY_TIMEOUT_MS" | "NOTIFY_RETRY_ATTEMPTS"
  >;
  getConfig: (repo: string) => Config | undefined;
}

// Dedup key per event kind — run_id is a UUID per cascade run, equivalent to source_sha for collision safety.
function dedupKey(event: NotifyEvent): string {
  const k = event.kind;
  if (k === "queue_overflow") return `_:${event.key}:_:${k}:${event.dropped_id}`;
  if (k === "config_invalid") return `${event.installation_id}:${event.repo}:pre-resolve:${k}`;
  if (k === "permission_error")
    return `${event.installation_id}:${event.repo}:${event.endpoint}:${event.status}:${k}`;
  // cascade_conflict and protection_blocked use run_id as the uniqueness carrier.
  return `${event.installation_id}:${event.repo}:${event.run_id}:${k}`;
}

async function sendSlack(
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<void> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    const retryAfterHeader = resp.headers.get("Retry-After");
    const retryAfterMs = retryAfterHeader
      ? parseInt(retryAfterHeader, 10) * 1000 || undefined
      : undefined;
    throw new HttpError(resp.status, errText, retryAfterMs);
  }
  // Slack returns 200 with text body "ok" — do not call resp.json().
}

const DISABLED_REPOS_MAX = 1024;
// 24h: observability returns daily — misconfig re-warns instead of being silenced forever
const DISABLED_REPOS_TTL_MS = 24 * 60 * 60 * 1000;

export class SlackChannel implements NotificationChannel {
  private readonly dedup: LRUCache<string, true>;
  // LRU with 24h TTL — bounds memory across many-repo installations AND restores observability for misconfig (D-03)
  private readonly disabledRepos = new LRUCache<string, true>({
    max: DISABLED_REPOS_MAX,
    ttl: DISABLED_REPOS_TTL_MS,
    ttlAutopurge: true,
    perf: { now: () => Date.now() },
  });
  private readonly retryOpts: RetryOpts;

  constructor(private readonly deps: SlackChannelDeps) {
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
      log.debug({ event: "notify_skipped_dedup", channel: "slack", kind: event.kind }, "notify");
      return;
    }

    const repo = "repo" in event ? event.repo : undefined;

    if (repo !== undefined) {
      const config = this.deps.getConfig(repo);
      if (!config?.notifications?.slack) {
        if (!this.disabledRepos.has(repo)) {
          log.info({ event: "notifications_disabled_for_repo", repo, channel: "slack" }, "notify");
          this.disabledRepos.set(repo, true);
        }
        return;
      }
    }

    const slackChannel =
      repo !== undefined ? this.deps.getConfig(repo)?.notifications?.slack?.channel : undefined;

    const body: Record<string, unknown> = { text: formatSlack(event) };
    if (slackChannel) {
      body.channel = slackChannel;
    }

    try {
      await withRetry(
        () => sendSlack(this.deps.webhookUrl, body, this.deps.env.NOTIFY_TIMEOUT_MS),
        this.retryOpts,
      );
      this.dedup.set(key, true);
      log.debug({ event: "notify_sent", channel: "slack", kind: event.kind, repo }, "notify");
    } catch (err) {
      log.warn(
        {
          event: "notify_delivery_failed",
          channel: "slack",
          kind: event.kind,
          repo,
          attempt_count: this.retryOpts.attempts,
          final_error_class: err instanceof Error ? err.name : "unknown",
          final_status: err instanceof HttpError ? err.status : undefined,
          event_payload: event,
        },
        "notify",
      );
    }
  }
}
