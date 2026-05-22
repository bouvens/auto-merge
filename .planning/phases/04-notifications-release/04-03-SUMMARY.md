---
phase: 04-notifications-release
plan: "03"
subsystem: notify-channels
tags: [notifications, slack, telegram, dedup, retry, dispatcher, lru]
dependency_graph:
  requires:
    - 04-01 (NotifyEvent, withRetry, HttpError, Env NOTIFY_* vars)
    - 04-02 (formatSlack, formatTelegram)
  provides:
    - src/notify/slack.ts (SlackChannel)
    - src/notify/telegram.ts (TelegramChannel, TelegramError)
    - src/notify/dispatcher.ts (MultiChannel)
    - test/unit/notify-dedup.test.ts (LRU TTL + eviction + isolation tests)
  affects:
    - src/index.ts (04-04 will swap NoopChannel for MultiChannel DI)
tech_stack:
  added: []
  patterns:
    - LRUCache<string, true> per-channel dedup (lru-cache v11, same construction as sourceShaDedup)
    - withRetry wrapping fetch with AbortSignal.timeout
    - Promise.allSettled in MultiChannel for error isolation
key_files:
  created:
    - src/notify/slack.ts
    - src/notify/telegram.ts
    - src/notify/dispatcher.ts
    - test/unit/notify-dedup.test.ts
  modified: []
decisions:
  - SlackChannel uses HTTP Retry-After header (seconds * 1000), TelegramChannel uses json.parameters.retry_after (seconds * 1000)
  - Dedup cache marked only after successful withRetry return, not on failure — failed events can retry next time
  - queue_overflow has no repo → Slack sends to webhook default channel (no channel field), Telegram skips with debug log
  - TelegramError class exported for test visibility, but sendTelegram throws HttpError internally so withRetry classification stays simple
  - MultiChannel swallows all Promise.allSettled rejections — each channel dead-letters via pino warn before returning
metrics:
  duration: "12 minutes"
  completed: "2026-05-22T10:33:35Z"
  tasks_completed: 2
  files_created: 4
---

# Phase 04 Plan 03: Notification Channels Summary

SlackChannel + TelegramChannel with per-channel LRU dedup, retry backoff, and dead-letter logging; MultiChannel aggregator using Promise.allSettled.

## What Was Built

### SlackChannel (`src/notify/slack.ts`)

Implements `NotificationChannel`. Deps: `{ webhookUrl, env, getConfig }`.

- LRUCache dedup keyed by `dedupKey(event)` — marked only on successful send (D-06)
- `withRetry` wraps `fetch` with `AbortSignal.timeout(NOTIFY_TIMEOUT_MS)`, 3 attempts
- Retry-After from HTTP header (Slack), not JSON body
- Per-repo config check: missing `notifications.slack` → `notifications_disabled_for_repo` log once, then no-op
- `queue_overflow` has no repo → sends to webhook default channel (omits `channel` field)
- Dead-letter: pino warn with `event: "notify_delivery_failed"`, channel, kind, repo, attempt_count, final_error_class, final_status, event_payload. Webhook URL never logged.

### TelegramChannel (`src/notify/telegram.ts`)

Mirrors SlackChannel structure. Deps: `{ botToken, env, getConfig }`.

- Endpoint: `https://api.telegram.org/bot${token}/sendMessage`
- Body: `{ chat_id, text, parse_mode: "HTML" }`
- `json.ok` check — Telegram returns 200 with `ok: false` on errors (Pitfall 2)
- `retry_after` from `json.parameters.retry_after` (seconds → ms)
- `queue_overflow` has no repo → no fallback chat_id → debug log `notify_skipped_no_config`, return
- `TelegramError` class exported; `sendTelegram` throws `HttpError` internally for `withRetry` compatibility

### MultiChannel (`src/notify/dispatcher.ts`)

```typescript
export class MultiChannel implements NotificationChannel {
  constructor(private readonly channels: NotificationChannel[]) {}
  async notify(event: NotifyEvent): Promise<void> {
    await Promise.allSettled(this.channels.map((c) => c.notify(event)));
  }
}
```

Empty channels array → resolves immediately. Never throws. Each channel dead-letters internally.

### Dedup Key Formula

```
queue_overflow:       _:{key}:_:queue_overflow:{dropped_id}
config_invalid:       {installation_id}:{repo}:pre-resolve:config_invalid
permission_error:     {installation_id}:{repo}:{endpoint}:{status}:permission_error
cascade_conflict:     {installation_id}:{repo}:{run_id}:cascade_conflict
protection_blocked:   {installation_id}:{repo}:{run_id}:protection_blocked
```

`run_id` is UUID per cascade run — equivalent to source_sha for dedup uniqueness.

### Unit Tests (`test/unit/notify-dedup.test.ts`)

Verifies LRU construction pattern directly:
- TTL expiry after 1h+1ms with fake timers
- TTL boundary: still present at 1h-1ms
- LRU cap eviction (cap=2, 3rd entry evicts oldest)
- Two independent instances do not share state

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface Scan

No new network endpoints or trust boundaries introduced. Webhook URL and bot token are stored only in `deps.webhookUrl` / `deps.botToken` on the instance and passed directly to `fetch()`. The dead-letter log uses `channel: "slack"|"telegram"` — never the URL or token. `log.ts` REDACT_PATHS also covers `webhookUrl` and `botToken` as belt-and-suspenders (T-04-08, T-04-09 mitigated).

## Known Stubs

None. `getConfig` callback is injected by caller — 04-04 will wire the real config loader. The channels are complete; only DI wiring is deferred.

## Self-Check: PASSED

- `src/notify/slack.ts` — exists, tsc passes
- `src/notify/telegram.ts` — exists, tsc passes
- `src/notify/dispatcher.ts` — exists, tsc passes
- `test/unit/notify-dedup.test.ts` — exists, 6 tests green
- Commit `6fbc41d` — Task 1
- Commit `85538d6` — Task 2
- 334 total tests pass, 0 regressions
