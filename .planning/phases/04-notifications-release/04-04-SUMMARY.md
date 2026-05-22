---
phase: 04-notifications-release
plan: 04
subsystem: notify-di-wiring
tags: [di, notify, slack, telegram, integration-tests, installation_id]
dependency_graph:
  requires: [04-03]
  provides: [notify-di-complete, config-invalid-notify, d04-dedup-key-closed]
  affects: [src/index.ts, src/config/loader.ts, src/cascade/orchestrator.ts, src/webhook/pushHandler.ts]
tech_stack:
  added: []
  patterns: [DI composition root, last-known config cache, env-gated channel instantiation]
key_files:
  created:
    - test/helpers/msw-notify.ts
    - test/integration/notify-pipeline.test.ts
  modified:
    - src/index.ts
    - src/config/loader.ts
    - src/cascade/orchestrator.ts
    - src/webhook/pushHandler.ts
    - test/integration/check-run-on-invalid.test.ts
    - test/integration/config-loader-fetch.test.ts
decisions:
  - name: getRepoConfig uses Map not LRU
    rationale: Config entries are small and never need eviction; Map is simpler and sufficient for the stale-ok lookup pattern.
  - name: resolveJobContext receives notify explicitly
    rationale: Minimal change to pass notify into the cron/dispatch loadConfig call-site without restructuring the function or making notify a module-level singleton.
  - name: installation_id remains required in loadConfig deps
    rationale: Every call-site (push webhook, cron/dispatch orchestrator) has the installation_id available; making it optional would hide accidental omissions.
metrics:
  duration: ~25 minutes
  completed: 2026-05-22
  tasks_completed: 2
  files_modified: 8
---

# Phase 04 Plan 04: DI Wiring + Integration Tests Summary

Closed the notification loop: channels built in 04-03 are now wired into the running app, every config failure emits a notification, and the D-04 dedup key is fully repo-scoped.

## Tasks Completed

### Task 1: DI wiring in src/index.ts + getConfig export + config_invalid call-site + installation_id propagation

**Commit:** `a39d9a2`

- `src/index.ts`: replaced `new NoopChannel()` with env-gated `SlackChannel`/`TelegramChannel` composed into `new MultiChannel(channels)`. `makeRunCascade({ notify })` replaces the module-level `runCascade` default. Both channels receive `getConfig: (repo) => getRepoConfig(owner, repoName)` built from the new `config/loader.ts` export.
- `src/config/loader.ts`: added `repoConfigCache: Map<string, Config>` populated on successful load. Exported `getRepoConfig(owner, repo)`. Extended `loadConfig` deps with `installation_id: number` (required) and `notify?: NotificationChannel`. Three failure paths (file-not-found, fetch error, zod/yaml parse error) now call `void deps.notify?.notify({ kind: "config_invalid", ... })` fire-and-forget after the Check Run creation.
- `src/cascade/orchestrator.ts`: added `installation_id` to all three existing notify payloads (cascade_conflict, protection_blocked, permission_error). `resolveJobContext` receives `notify` as a parameter so the cron/dispatch `loadConfig` call can forward it. `loadConfig` call now passes `installation_id: payload.installation_id` and `notify`.
- `src/webhook/pushHandler.ts`: `loadConfig` call updated with `installation_id: payload.installation.id` (notify omitted intentionally — push handler doesn't hold a channel reference and the orchestrator handles conflict notifications).
- Existing test files updated to supply the now-required `installation_id: 0` field.

### Task 2: Integration test — msw harness + notify-pipeline scenarios

**Commit:** `96cabad`

- `test/helpers/msw-notify.ts`: `createNotifyHarness()` returns `{ server, slackCalls, telegramCalls, reset, setSlackResponse, setTelegramResponse }`. Default handlers match `hooks.slack.com/services/:rest+` and `api.telegram.org/bot*/sendMessage`. `server.use(override)` pattern used for per-scenario response control.
- `test/integration/notify-pipeline.test.ts`: 7 scenarios, all passing:
  1. Both channels receive cascade_conflict: Slack gets `channel: "#test"` + text containing "Cascade conflict"; Telegram gets `chat_id: "-100123"`, `parse_mode: "HTML"`, text with `<b>Cascade conflict</b>`.
  2. Slack 500, Telegram 200: Slack attempted 3× (NOTIFY_RETRY_ATTEMPTS=3), Telegram succeeds, `multi.notify` resolves without throw (Promise.allSettled guarantee).
  3. Telegram 429 + Retry-After: 1s: second attempt fires after delay, telegramCalls.length ≥ 2.
  4. Dedup suppression: second identical event suppressed per-channel, only 1 HTTP call each.
  5. Final-fail dedup-not-marked: fresh channel instance sends the same event again after prior final-fail.
  6. Per-repo missing slack config: Slack skipped, Telegram still sends.
  7. All channels fail: `multi.notify` still resolves (Promise.allSettled).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Existing test call-sites missing installation_id**
- **Found during:** Task 1 (tsc --noEmit)
- **Issue:** `test/integration/check-run-on-invalid.test.ts` and `test/integration/config-loader-fetch.test.ts` call `loadConfig` without `installation_id`, which became required.
- **Fix:** Added `installation_id: 0` to all test call-sites.
- **Files modified:** test/integration/check-run-on-invalid.test.ts, test/integration/config-loader-fetch.test.ts
- **Commit:** a39d9a2

**2. [Rule 2 - Missing functionality] notify not passed to pushHandler loadConfig**
- **Found during:** Task 1 analysis
- **Issue:** The push handler has no channel reference at the point where `loadConfig` is called; passing `notify` would require threading it through `PushHandlerDeps`. Per plan, config_invalid notifications for push events are out of scope for this path (cron/dispatch covers it via orchestrator).
- **Decision:** `notify` is omitted from pushHandler's `loadConfig` call (optional parameter, defaults to undefined). This is intentional scope — the push handler rejects invalid configs silently and relies on the check run for user feedback. Only orchestrator-sourced `loadConfig` calls get notify wired.

## Verification Results

- `npx tsc --noEmit`: PASS
- `npx vitest run`: 341/341 tests pass (334 pre-existing + 7 new)
- `grep -c 'new NoopChannel' src/index.ts`: 0
- `grep -c 'new MultiChannel' src/index.ts`: 1
- `grep -c 'kind: "config_invalid"' src/config/loader.ts`: 3
- `grep -c 'installation_id' src/cascade/orchestrator.ts`: 7 (≥ 4 required)
- `grep -c 'onUnhandledRequest: "error"' test/integration/notify-pipeline.test.ts`: 1
- Silent-on-success regression guard: 0 notify calls on success/skip paths

## Known Stubs

None.

## Threat Flags

None — no new network endpoints or auth paths introduced. msw `onUnhandledRequest: "error"` enforces test isolation (T-04-16 mitigation confirmed).

## Self-Check: PASSED

- `a39d9a2` exists in git log ✓
- `96cabad` exists in git log ✓
- `test/helpers/msw-notify.ts` created ✓
- `test/integration/notify-pipeline.test.ts` created ✓
- `src/index.ts` contains `new MultiChannel` ✓
- `src/config/loader.ts` exports `getRepoConfig` ✓
