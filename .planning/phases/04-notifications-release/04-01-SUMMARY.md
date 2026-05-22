---
phase: 04-notifications-release
plan: "01"
subsystem: notify-foundation
tags: [notifications, types, utilities, env, tdd]
dependency_graph:
  requires: []
  provides:
    - src/notify/channel.ts (extended NotifyEvent union)
    - src/notify/escape.ts (escapeHtml, truncate)
    - src/notify/retry.ts (withRetry, HttpError, RetryOpts)
    - src/env.ts (NOTIFY_DEDUP_TTL_MS, NOTIFY_DEDUP_MAX, NOTIFY_TIMEOUT_MS, NOTIFY_RETRY_ATTEMPTS)
  affects:
    - All Phase 4 plans that import from src/notify/escape.js and src/notify/retry.js
    - All tests that use the Env type (updated with 4 new required fields)
tech_stack:
  added: []
  patterns:
    - Object-map RETRYABLE_ERROR_NAMES instead of switch-case for retry classification
    - zod coerce.number().int().positive().default() for env field pattern
key_files:
  created:
    - src/notify/escape.ts
    - src/notify/retry.ts
    - test/unit/notify-escape.test.ts
    - test/unit/notify-retry.test.ts
  modified:
    - src/notify/channel.ts (NotifyEvent union extended with config_invalid + optional fields)
    - src/env.ts (4 NOTIFY_ fields added)
    - test/unit/env.test.ts (Phase 4 describe block added)
    - test/unit/auth-readyz.test.ts (Env fixture updated)
    - test/unit/auth-app-octokit.test.ts (Env fixture updated)
    - test/unit/auth-bot-identity.test.ts (Env fixture updated)
    - test/integration/readyz.test.ts (Env fixture updated)
    - test/integration/push-webhook.test.ts (Env fixture updated)
    - test/integration/dispatch-webhook.test.ts (Env fixture updated)
    - test/integration/webhook-flow.test.ts (Env fixture updated)
    - test/integration/healthz.test.ts (Env fixture updated)
decisions:
  - NotifyEvent.installation_id is optional on all repo-bearing kinds so Phase 3 call-sites remain valid until 04-04 wires real values
  - escapeHtml replaces & first (before < and >) to prevent double-escaping existing entities
  - withRetry uses object-map RETRYABLE_ERROR_NAMES (no switch-case per CLAUDE.md)
  - Test opts use baseDelayMs=10 to keep fake-timer-based retry tests fast (no multi-second wall-clock delays)
metrics:
  duration: "10 min"
  completed: "2026-05-22T10:23:06Z"
  tasks: 2
  files: 11
---

# Phase 04 Plan 01: Notify Foundation Summary

Extended NotifyEvent union with config_invalid kind + optional author_login/installation_id on conflict arms; added escapeHtml/truncate utility and withRetry/HttpError retry helper; wired 4 NOTIFY_ env variables with zod coercion and defaults.

## What Was Built

### Task 1: Extend NotifyEvent union + add escape/retry utilities

**src/notify/channel.ts** — Extended NotifyEvent discriminated union:
- `cascade_conflict` and `protection_blocked` arms: added optional `author_login?: string` (D-10) and `installation_id?: number` (D-04)
- `permission_error` arm: added optional `installation_id?: number` (D-04)
- New 5th arm: `config_invalid` with `repo`, `config_path`, `zod_error`, and optional `installation_id` (D-15 + D-04)
- `queue_overflow` and `NoopChannel` unchanged (tests still depend on them)

**src/notify/escape.ts** — Pure string utilities:
- `escapeHtml(s)`: replaces `&` → `&amp;` first, then `<` → `&lt;`, `>` → `&gt;`
- `truncate(s, limit=4000, suffix="…[truncated]")`: slices at limit and appends suffix

**src/notify/retry.ts** — HTTP retry helper:
- `class HttpError extends Error` with `status`, `bodyText`, `retryAfterMs?`
- `interface RetryOpts` with `attempts`, `baseDelayMs`, `jitterMs`, `maxRetryAfterMs`
- `async function withRetry<T>` — exponential backoff loop; 4xx breaks immediately; 5xx/429/network errors retry up to `attempts` times; Retry-After capped at `maxRetryAfterMs`
- Internal `RETRYABLE_ERROR_NAMES` object-map (TimeoutError, AbortError, TypeError) — no switch-case

### Task 2: Add 4 NOTIFY_ env variables

**src/env.ts** — 4 new fields in Base zod schema:
- `NOTIFY_DEDUP_TTL_MS`: default 3_600_000 (1 hour)
- `NOTIFY_DEDUP_MAX`: default 1000
- `NOTIFY_TIMEOUT_MS`: default 5000 (5s)
- `NOTIFY_RETRY_ATTEMPTS`: default 3
- All use `z.coerce.number().int().positive()` for consistent env coercion and fail-fast validation

## Tests Added

- `test/unit/notify-escape.test.ts` — 10 cases covering escapeHtml entities, order, empty string; truncate boundary conditions
- `test/unit/notify-retry.test.ts` — 13 cases covering 5xx retry count, 4xx immediate break, 429 Retry-After cap, TimeoutError/AbortError/TypeError classification, success on first attempt, recovery after transient error
- `test/unit/env.test.ts` — 11 new cases in "Phase 4 notify env fields" describe block

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Updated Env fixture objects in test files**

- **Found during:** Task 2
- **Issue:** Adding 4 required fields to `Env` type broke TypeScript compilation in 9 test files that used hardcoded `Env` literal objects without the new fields
- **Fix:** Added `NOTIFY_DEDUP_TTL_MS: 3_600_000`, `NOTIFY_DEDUP_MAX: 1000`, `NOTIFY_TIMEOUT_MS: 5000`, `NOTIFY_RETRY_ATTEMPTS: 3` defaults to all affected test fixtures
- **Files modified:** `test/unit/auth-readyz.test.ts`, `test/unit/auth-app-octokit.test.ts`, `test/unit/auth-bot-identity.test.ts`, `test/integration/readyz.test.ts`, `test/integration/push-webhook.test.ts`, `test/integration/dispatch-webhook.test.ts`, `test/integration/webhook-flow.test.ts`, `test/integration/healthz.test.ts`
- **Commit:** 16e2489

**2. [Rule 1 - Bug] Reduced baseDelayMs in test opts to keep fake-timer tests fast**

- **Found during:** Task 1
- **Issue:** Using `baseDelayMs: 1000` with `vi.advanceTimersByTimeAsync` caused tests to take proportional real time (~3s per 3-attempt test, ~30s for 30s cap test)
- **Fix:** Changed `defaultOpts.baseDelayMs` to `10ms` and `maxRetryAfterMs` test to use `100ms` cap — tests now run in milliseconds
- **Files modified:** `test/unit/notify-retry.test.ts`
- **Commit:** 029b144

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes at trust boundaries.

T-04-02 (DoS via unbounded Retry-After): `maxRetryAfterMs` cap implemented in `withRetry` and verified in test.
T-04-03 (Tampering via env coercion): `z.coerce.number().int().positive()` rejects zero/negative/NaN for all 4 NOTIFY_ vars.

## Known Stubs

None — this plan only adds pure utilities and types; no UI rendering or data flow.

## Self-Check: PASSED

Files exist:
- /Users/alex/work/auto-merge/src/notify/escape.ts ✓
- /Users/alex/work/auto-merge/src/notify/retry.ts ✓
- /Users/alex/work/auto-merge/test/unit/notify-escape.test.ts ✓
- /Users/alex/work/auto-merge/test/unit/notify-retry.test.ts ✓

Commits exist:
- 029b144: feat(04-01): extend NotifyEvent union + add escape/retry utilities ✓
- 16e2489: feat(04-01): add 4 NOTIFY_ env variables to src/env.ts ✓
