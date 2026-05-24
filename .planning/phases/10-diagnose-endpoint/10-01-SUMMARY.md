---
phase: 10-diagnose-endpoint
plan: 01
subsystem: diagnose
tags: [diagnose, rate-limit, redaction, lru-cache, security, tdd]

requires:
  - phase: 06-foundation-env-notify-healthcheck
    provides: DIAGNOSE_TOKEN env var (consumed by Plan 10-04, not here)
provides:
  - createDiagnoseRateLimit() factory with per-IP rolling-window cap (DIAG-03 primitive)
  - redactSlackUrl() / redactSecret() pure helpers (DIAG-04 primitive)
affects: [10-diagnose-endpoint future plans (10-04 handler)]

tech-stack:
  added: []
  patterns:
    - "Co-located src/**/*.test.ts unit tests for pure-logic modules (mirrors LRU dedup style)"
    - "LRU TTL-cache + ttlResolution:0 for deterministic fake-timer testing"

key-files:
  created:
    - src/diagnose/rateLimit.ts
    - src/diagnose/rateLimit.test.ts
    - src/diagnose/redact.ts
    - src/diagnose/redact.test.ts
  modified:
    - vitest.config.ts

key-decisions:
  - "Hard cap of 10 hits per IP per window is a non-configurable constant per DIAG-03"
  - "ttlResolution:0 chosen so vi.useFakeTimers() drives window rollover deterministically"
  - "byte_length via Buffer.byteLength(value, 'utf8') — counts UTF-8 bytes, not code units"
  - "vitest include extended to src/**/*.test.ts so co-located units run alongside test/** suites"

patterns-established:
  - "Diagnose pure-logic primitives live in src/diagnose/*.ts with tests adjacent"
  - "Redaction helpers are pure functions; no top-level side effects (tree-shakeable)"

requirements-completed: [DIAG-03, DIAG-04]

duration: ~5min
completed: 2026-05-24
---

# Phase 10 Plan 01: Rate-limit + redaction primitives Summary

**LRU-backed per-IP rate-limiter (10/min, retry-after) and Slack-URL / secret redaction helpers — pure modules with co-located vitest coverage, zero new dependencies.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-05-24T16:53:00Z
- **Completed:** 2026-05-24T16:55:50Z
- **Tasks:** 2 (both TDD)
- **Files modified:** 5 (4 created, 1 modified)

## Accomplishments

- `createDiagnoseRateLimit()` factory delivering `{ check(ip) }` with `LRUCache<string, { count, resetAt }>`, `max=10_000`, `ttl=60_000`, `ttlAutopurge: true`, `ttlResolution: 0`; hard 10-per-window cap; `Math.ceil` retry-after seconds.
- `redactSlackUrl()` masks segment after last `/`; preserves workspace prefix (`https://hooks.slack.com/services/T1/B1/****`).
- `redactSecret()` returns `{ present, byte_length }` via `Buffer.byteLength(value, 'utf8')` for utf-8 truncation detection without leaking value.
- Co-located vitest suites (5 + 5 tests) all green; biome clean; no `any`; no new dependencies.

## Task Commits

1. **Task 1 RED — rate-limit failing tests** — `bb99031` (test)
2. **Task 1 GREEN — rate-limit implementation** — `943c6df` (feat)
3. **Task 2 RED — redact failing tests** — `499a4eb` (test)
4. **Task 2 GREEN — redact implementation** — `c121c9a` (feat)

## Files Created/Modified

- `src/diagnose/rateLimit.ts` — LRU-backed per-IP rate-limit factory (DIAG-03)
- `src/diagnose/rateLimit.test.ts` — 5 unit tests (allow/deny/window-reset/per-IP-isolation/Math.ceil)
- `src/diagnose/redact.ts` — `redactSlackUrl` + `redactSecret` pure helpers (DIAG-04)
- `src/diagnose/redact.test.ts` — 5 unit tests covering nullish, masked URL, no-slash, undefined secret, present secret
- `vitest.config.ts` — added `src/**/*.test.ts` to `include` so co-located units are discovered

## Decisions Made

- Hard cap `HARD_CAP_PER_WINDOW = 10` is a module-private constant (not a parameter) per DIAG-03 spec — preventing accidental relaxation by callers.
- LRU `ttl` + `ttlAutopurge` chosen over a manual sweep — same idiom as `src/cascade/sourceShaDedup.ts`, zero new deps (`lru-cache` already a direct dep).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Extended vitest `include` to discover `src/**/*.test.ts`**
- **Found during:** Task 1 (RED step)
- **Issue:** Plan frontmatter and `<action>` block explicitly mandate co-located test files at `src/diagnose/rateLimit.test.ts` and `src/diagnose/redact.test.ts`, but `vitest.config.ts` only matched `test/**/*.test.ts`. Running the RED test returned "No test files found" instead of a proper failure — blocking the TDD cycle.
- **Fix:** Added `"src/**/*.test.ts"` to `test.include`. Existing `test/**` suites continue to run unchanged.
- **Files modified:** `vitest.config.ts`
- **Verification:** `npx vitest run src/diagnose/` discovers 2 files / 10 tests, all green.
- **Committed in:** `bb99031` (RED commit for Task 1)

---

**Total deviations:** 1 auto-fixed (1 blocking — test discovery)
**Impact on plan:** Necessary to honour the plan's explicit co-located test paths; no scope creep, no behaviour change for existing `test/**` suites.

## Issues Encountered

None.

## User Setup Required

None — pure-logic primitives, no external service configuration.

## Next Phase Readiness

- DIAG-03 / DIAG-04 primitives ready to import from Plan 10-04 (Fastify handler glue).
- No FROZEN-component touched. Composition with `loadConfig`, `getInstallationOctokit`, `NotifyHealthChecker` remains a Plan 10-04 concern.

## Self-Check: PASSED

- `src/diagnose/rateLimit.ts` — FOUND
- `src/diagnose/rateLimit.test.ts` — FOUND
- `src/diagnose/redact.ts` — FOUND
- `src/diagnose/redact.test.ts` — FOUND
- Commits `bb99031`, `943c6df`, `499a4eb`, `c121c9a` — FOUND in `git log`

---
*Phase: 10-diagnose-endpoint*
*Completed: 2026-05-24*
