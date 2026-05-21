---
phase: 03-reliability-operations
plan: "07"
subsystem: shutdown
tags: [graceful-shutdown, sigterm, cron, drain, ops]
dependency_graph:
  requires: [03-02, 03-05]
  provides: [OPS-03]
  affects: [src/index.ts, src/shutdown.ts, README.md]
tech_stack:
  added: []
  patterns: [dependency-injection, exit-stub-marker]
key_files:
  created:
    - src/shutdown.ts
    - test/integration/shutdown.test.ts
  modified:
    - src/index.ts
    - README.md
decisions:
  - "Extracted makeShutdown to src/shutdown.ts to enable dep-injection in tests without booting the full application"
  - "Added EXIT_THROW_MARKER sentinel on thrown exit errors so catch block re-throws instead of masking exit code with process.exit(1)"
  - "Drain timeout test uses synchronous mock (not fake timers + setTimeout) to avoid unhandled-rejection timing issues with vi.advanceTimersByTimeAsync"
  - "shutdown sequence: cronHandle.stop → app.close → multiQueue.drain → exit 0 (D-18 ordering)"
metrics:
  duration: "25 min"
  completed: "2026-05-21"
  tasks_completed: 3
  files_changed: 4
---

# Phase 03 Plan 07: Graceful Shutdown (OPS-03) Summary

Finalized graceful shutdown: SIGTERM now stops the cron scheduler first (5 s budget via `stopCronGracefully`), then closes the Fastify HTTP server, then drains per-repo queues up to `SHUTDOWN_TIMEOUT` (default 30 s), then exits 0. Drain timeout is exit 0 per D-19. Double-SIGTERM is idempotent via a `shuttingDown` flag.

## Tasks Completed

| Task | Name | Commit | Key files |
|---|---|---|---|
| 1 | Extend SIGTERM/SIGINT handler (D-18 ordering) | dc5367b | src/index.ts |
| 2 | Integration tests — signal-driven shutdown | 76b7e7a | src/shutdown.ts, test/integration/shutdown.test.ts |
| 3 | README graceful shutdown + container grace period | 699cbae | README.md |

## Decisions Made

1. **`makeShutdown` in own module** — `src/shutdown.ts` exports `makeShutdown` and `makeExitStub`. Tests import from the module directly, bypassing the boot-side-effect in `src/index.ts`.

2. **EXIT_THROW_MARKER sentinel** — `process.exit` mock throws an error tagged with `__process_exit_throw__`. The `catch` block in `makeShutdown` detects the marker and re-throws, preventing `process.exit(1)` from masking the intended exit code.

3. **Drain timeout test: synchronous mock** — Using `setTimeout` + `vi.advanceTimersByTimeAsync` for the drain produced an unhandled-rejection warning because the promise rejection happened in a microtask after the test's `await expect` chain. Replaced with a synchronous mock that immediately logs and resolves, eliminating the race.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Testability] Extracted shutdown to src/shutdown.ts**

- **Found during:** Task 2 — `src/index.ts` runs boot side-effects on import (loadEnv, createProbot, etc.), making it impossible to import `makeShutdown` in tests without env vars.
- **Fix:** Moved `makeShutdown` and `ShutdownDeps` to `src/shutdown.ts`. Added `makeExitStub` helper. `src/index.ts` imports and re-uses the factory. No behaviour change.
- **Files modified:** src/shutdown.ts (new), src/index.ts (import refactor)
- **Commit:** 76b7e7a

## Verification

- `npx vitest run` — 260 tests pass (including 4 new shutdown integration tests)
- `npx tsc --noEmit` — clean
- SIGTERM handler ordering: cron.stop → app.close → queue.drain (proved by callOrder spy in test)
- Double-SIGTERM idempotency: cronHandle.stop called once only (proved by toHaveBeenCalledOnce)
- Drain timeout exits 0 (proved by exit stub assertion)
- Cron-disabled no-op handle: clean shutdown path (proved by test)

## Self-Check: PASSED

Files exist:
- src/shutdown.ts: FOUND
- src/index.ts: FOUND (modified)
- test/integration/shutdown.test.ts: FOUND
- README.md: FOUND (modified)

Commits exist:
- dc5367b: FOUND
- 76b7e7a: FOUND
- 699cbae: FOUND
