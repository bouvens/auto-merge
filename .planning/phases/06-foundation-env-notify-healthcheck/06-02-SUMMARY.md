---
phase: 06-foundation-env-notify-healthcheck
plan: 02
subsystem: notify
tags: [healthcheck, probe, ttl-cache, single-flight, msw]
dependency_graph:
  requires: []
  provides:
    - probeSlack
    - probeTelegram
    - createNotifyHealthChecker
    - NotifyStatus
    - NotifyStatusReport
  affects:
    - src/index.ts (Plan 06-04 wiring)
    - src/server.ts (Plan 06-03 readyz extension)
tech_stack:
  added: []
  patterns:
    - AbortSignal.timeout(3000) for per-probe deadline
    - Closure-state TTL cache (no LRU — 2 keys)
    - Single-flight via shared in-flight Promise
    - Promise.allSettled to isolate per-channel failures
key_files:
  created:
    - src/notify/healthCheck.ts
    - test/helpers/msw-healthcheck.ts
    - test/unit/notify-healthcheck.test.ts
  modified: []
decisions:
  - D-01 honored — Slack probe uses GET; any HTTP response treated as reachable
  - D-05 honored — PROBE_TIMEOUT_MS hardcoded 3000 (not from env)
  - D-06 honored — single file, closure cache, NotifyStatus union with "misconfigured" (Telegram 401)
metrics:
  tasks_completed: 3
  files_created: 3
  files_modified: 0
  tests_added: 14
  duration_minutes: ~10
  completed_date: 2026-05-22
requirements:
  - DIAG-05
---

# Phase 6 Plan 02: notify healthCheck module Summary

Implemented `src/notify/healthCheck.ts` — single-file module exposing `probeSlack`, `probeTelegram`, and `createNotifyHealthChecker(env)` factory with TTL cache + single-flight refresh, plus msw GET-handlers harness and 14 unit tests proving the DIAG-05 single-flight invariant (100 cached getStatus calls = 1 upstream fetch per channel).

## What Built

**`src/notify/healthCheck.ts`** (108 LOC):
- `probeSlack(url, timeoutMs)` — GET with `AbortSignal.timeout`; `>=500` or throw → `unreachable`; any other HTTP status → `ok` (D-01 — webhook URL returns 400/403/404/405 for empty-body GET, all treated as reachable).
- `probeTelegram(token, timeoutMs)` — GET on `bot{token}/getMe`; 401 → `misconfigured`; `>=500` → `unreachable`; `resp.ok` → `ok`; throw → `unreachable`.
- `createNotifyHealthChecker(env)` — returns `{ getStatus, refresh }`. Channels absent from env seeded as permanent `n/a`. Single-flight via shared `refreshing: Promise<void> | null`. Lazy refresh — `getStatus()` fires `void refresh()` when expired, returns current cached value (`"pending"` before first probe). `PROBE_TIMEOUT_MS = 3000` hardcoded per D-05.

**`test/helpers/msw-healthcheck.ts`** (60 LOC):
- `createHealthCheckHarness()` — separate from `msw-notify.ts` (which is POST-only). GET handlers for `https://hooks.slack.com/services/*` and `https://api.telegram.org/bot*/getMe`. Per-channel `setSlack(status, delay?)` / `setTelegram(status, body, delay?)`, hit counters `slackCalls()` / `telegramCalls()`, `reset()`.

**`test/unit/notify-healthcheck.test.ts`** (132 LOC, 14 tests):
- probeSlack: 200, 400, 405 → ok; 503, timeout → unreachable.
- probeTelegram: 200 → ok; 401 → misconfigured; 500, timeout → unreachable.
- createNotifyHealthChecker: n/a for absent channels; pending pre-refresh; **100 getStatus()** within TTL → 1 upstream fetch per channel; 3 concurrent `refresh()` → 1 upstream fetch (single-flight); expired cache → lazy refresh triggers second probe.
- Timeout tests use real `setTimeout` delay (Pitfall 5 — no `vi.useFakeTimers` with real fetch).

## Commits

- `42c7815` feat(06-02): add notify healthCheck probes + TTL cache + single-flight
- `3ea92de` test(06-02): add msw GET-handlers harness for healthCheck
- `b9f0f5c` test(06-02): cover probes + TTL cache + single-flight + lazy refresh

## Verification

- `npx vitest run test/unit/notify-healthcheck.test.ts` — **14/14 PASS** (815ms).
- `npx vitest run` (full suite) — **365/365 PASS** across 42 files, no regression.
- `npx tsc --noEmit` — files added by this plan are clean. Pre-existing tsc errors in unrelated `test/integration/*.test.ts` and several `test/unit/auth-*.test.ts` are caused by uncommitted `src/env.ts` changes from parallel Plan 06-01 (Wave 0 sibling) that adds required env fields not yet present in those test fixtures. Out of scope for this plan (Plan 06-02 does not modify `src/env.ts` per D-06).

## Deviations from Plan

None — plan executed exactly as written. All three D-decisions (D-01 GET, D-05 hardcoded 3000ms timeout, D-06 single file + closure cache) honored verbatim.

## Success Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Module exports probeSlack, probeTelegram, createNotifyHealthChecker, NotifyStatus, NotifyStatusReport | PASS | `src/notify/healthCheck.ts` exports verified by test imports |
| 2 | probeSlack: 200/400/405 → ok; 5xx/throw → unreachable | PASS | 5 unit tests |
| 3 | probeTelegram: 200 → ok; 401 → misconfigured; 5xx/throw → unreachable | PASS | 4 unit tests |
| 4 | Single-flight: 3 concurrent refresh() → 1 upstream fetch per channel | PASS | `toBe(1)` assertion after `Promise.all([refresh, refresh, refresh])` |
| 5 | TTL-cache: 100 getStatus() within TTL → 1 upstream fetch per channel | PASS | `toBe(1)` assertion after 100-iteration loop post-refresh |

## Coordination Notes

- This plan deliberately does NOT import from `src/env.ts` (D-06). Factory accepts a structural env subset (`SLACK_WEBHOOK_URL?`, `TELEGRAM_BOT_TOKEN?`, `NOTIFY_HEALTHCHECK_TTL_MS`), decoupling Wave-0 parallel work.
- Wiring (`src/index.ts`) and `/readyz` route extension (`src/server.ts`) are owned by sibling plans 06-03 / 06-04.

## Self-Check: PASSED

- `src/notify/healthCheck.ts` — FOUND
- `test/helpers/msw-healthcheck.ts` — FOUND
- `test/unit/notify-healthcheck.test.ts` — FOUND
- Commit `42c7815` — FOUND
- Commit `3ea92de` — FOUND
- Commit `b9f0f5c` — FOUND
