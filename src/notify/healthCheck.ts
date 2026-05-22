export type NotifyStatus = "ok" | "unreachable" | "misconfigured" | "n/a" | "pending";

export type NotifyStatusReport = {
  slack: NotifyStatus;
  telegram: NotifyStatus;
};

// D-01: Slack treats any HTTP response on its webhook URL as "reachable" — only 5xx / network = unreachable.
export async function probeSlack(url: string, timeoutMs: number): Promise<NotifyStatus> {
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status >= 500) return "unreachable";
    return "ok";
  } catch {
    return "unreachable";
  }
}

// 401 distinguishes an invalid bot token (misconfigured) from network/server failure (unreachable).
export async function probeTelegram(token: string, timeoutMs: number): Promise<NotifyStatus> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status === 401) return "misconfigured";
    if (resp.status >= 500) return "unreachable";
    if (resp.ok) return "ok";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

type Entry = { value: NotifyStatus; expiresAt: number };

export interface NotifyHealthChecker {
  getStatus(): NotifyStatusReport;
  refresh(): Promise<void>;
}

const PROBE_TIMEOUT_MS = 3000;

export function createNotifyHealthChecker(env: {
  SLACK_WEBHOOK_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  NOTIFY_HEALTHCHECK_TTL_MS: number;
}): NotifyHealthChecker {
  const ttl = env.NOTIFY_HEALTHCHECK_TTL_MS;
  const cache: Partial<Record<"slack" | "telegram", Entry>> = {};

  if (!env.SLACK_WEBHOOK_URL) {
    cache.slack = { value: "n/a", expiresAt: Number.POSITIVE_INFINITY };
  }
  if (!env.TELEGRAM_BOT_TOKEN) {
    cache.telegram = { value: "n/a", expiresAt: Number.POSITIVE_INFINITY };
  }

  // Single-flight — concurrent refresh() / getStatus() bursts coalesce into one upstream probe per channel.
  let refreshing: Promise<void> | null = null;

  const isExpired = (e: Entry | undefined): boolean => !e || e.expiresAt <= Date.now();

  async function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const slackP: Promise<NotifyStatus> = env.SLACK_WEBHOOK_URL
        ? probeSlack(env.SLACK_WEBHOOK_URL, PROBE_TIMEOUT_MS)
        : Promise.resolve<NotifyStatus>("n/a");
      const tgP: Promise<NotifyStatus> = env.TELEGRAM_BOT_TOKEN
        ? probeTelegram(env.TELEGRAM_BOT_TOKEN, PROBE_TIMEOUT_MS)
        : Promise.resolve<NotifyStatus>("n/a");
      const settled = await Promise.allSettled([slackP, tgP]);
      const [slack, telegram] = settled.map((r): NotifyStatus =>
        r.status === "fulfilled" ? r.value : "unreachable",
      ) as [NotifyStatus, NotifyStatus];
      const expiresAt = Date.now() + ttl;
      cache.slack = {
        value: slack,
        expiresAt: env.SLACK_WEBHOOK_URL ? expiresAt : Number.POSITIVE_INFINITY,
      };
      cache.telegram = {
        value: telegram,
        expiresAt: env.TELEGRAM_BOT_TOKEN ? expiresAt : Number.POSITIVE_INFINITY,
      };
    })();
    try {
      await refreshing;
    } finally {
      refreshing = null;
    }
  }

  function getStatus(): NotifyStatusReport {
    if (isExpired(cache.slack) || isExpired(cache.telegram)) {
      void refresh();
    }
    return {
      slack: cache.slack?.value ?? "pending",
      telegram: cache.telegram?.value ?? "pending",
    };
  }

  return { getStatus, refresh };
}
