---
phase: 07-config-default-fallback
plan: 04
subsystem: config
tags: [config, boot, shutdown, lifecycle, e2e]
requires:
  - "src/config/defaultLoader.ts (initDefaultConfigLoader, stopDefaultConfigLoader from 07-02)"
  - "src/config/loader.ts (fallback hook sites from 07-03)"
  - "src/shutdown.ts (ShutdownDeps shape from Phase 6)"
provides:
  - "production boot wiring of the default config loader singleton"
  - "shutdown ordering guarantee: cron → defaultLoader → app → drain"
  - "end-to-end integration coverage of the full composition"
affects:
  - "src/index.ts boot sequence"
  - "src/shutdown.ts ShutdownDeps interface (breaking — new mandatory field)"
tech-stack:
  added: []
  patterns:
    - "module-singleton init/get/stop trio threaded through process lifecycle"
    - "scoped fake timers (toFake: setInterval+clearInterval) to combine fake-timer ticks with real MSW network"
key-files:
  created:
    - test/integration/config-default-end-to-end.test.ts
  modified:
    - src/index.ts
    - src/shutdown.ts
    - test/integration/shutdown.test.ts
decisions:
  - "Place initDefaultConfigLoader OUTSIDE the boot try/catch — fail-fast on missing/invalid default mirrors loadEnv() and avoids swallowing deploy bugs as boot_failed."
  - "Pass appLog (validated env logger) into initDefaultConfigLoader, NOT the log.ts module singleton — R-7."
  - "Shutdown order: cron.stop → defaultLoaderStop → app.close → multiQueue.drain. defaultLoader has no in-flight work to drain, only an interval handle."
  - "E2E test uses scoped fake timers (toFake) so MSW + undici outbound HTTP keeps working under fake clock."
metrics:
  duration: ~10m
  completed: 2026-05-23
---

# Phase 7 Plan 04: Boot + shutdown wiring + end-to-end Summary

Final wiring for Phase 7: `initDefaultConfigLoader` is now called at boot before any webhook can fire, `stopDefaultConfigLoader` is invoked during graceful shutdown, and a composition test verifies the full path real-defaultLoader → real-loader → MSW-404 → fallback through the public `loadConfig` contract.

## Tasks Completed

| Task | Commit  | Files                                                                          |
| ---- | ------- | ------------------------------------------------------------------------------ |
| 1    | 1f1e441 | src/index.ts, src/shutdown.ts                                                  |
| 2    | ea7db70 | test/integration/shutdown.test.ts                                              |
| 3    | 10a80c0 | test/integration/config-default-end-to-end.test.ts                             |

## Verification

- `npm run -s build` → 0 (passes)
- `npm run -s test` → 47 files, 399 tests, all green
- `npm run -s test -- test/integration/config-default-end-to-end.test.ts` → 3 tests green
- `npm run -s test -- test/integration/shutdown.test.ts` → 4 tests green

## Acceptance Grep (Task 1)

- `grep -c 'initDefaultConfigLoader' src/index.ts` → 2 (import + call) ✔
- `grep -c 'stopDefaultConfigLoader' src/index.ts` → 2 (import + makeShutdown field) ✔
- `grep -c 'defaultLoaderStop' src/shutdown.ts` → 2 (interface field + call) ✔
- `grep -n 'initDefaultConfigLoader(env, appLog)' src/index.ts` → line 22, BEFORE `try {` at line 27 ✔
- `grep -B1 'await deps.app?.close()' src/shutdown.ts` → `deps.defaultLoaderStop();` directly above ✔

## Phase 7 Success Criteria — End-to-End Observable

All four ROADMAP criteria now verifiable in the new `config-default-end-to-end.test.ts`:

1. **Repo without `.github/auto-merge.yml` + `DEFAULT_CASCADE_CONFIG_FILE` → cascades via default.** Test case 1 — 404 + FILE default → `source: 'file_default'`, `getRepoConfig("o","r")` populated.
2. **Precedence repo > file > env + log `config_source` per-load.** Plan 07-03 task 2 covered repo>file>env; logs assert in 07-03 integration; this plan reinforces via `source` assertion on the fallback return value.
3. **Boot fail-fast on invalid default.** Implemented in 07-02 (`createDefaultConfigLoader` calls `exit(1)` on missing file or invalid YAML); preserved here by the unchanged `defaultLoader.ts`.
4. **Hot-reload of the file via mtime polling 60s.** Test case 2 — mtime bump + `advanceTimersByTimeAsync(60_000)` + new sha → next `loadConfig` returns `dev_branch: 'develop'`. The `default_config_reloaded` log line is emitted (visible in test output).

## Deviations from Plan

### [Rule 1 — Bug] Scoped fake timers for e2e test

- **Found during:** Task 3 first test run.
- **Issue:** Plan's pseudo-code switched `vi.useFakeTimers()` on/off around `advanceTimersByTimeAsync`. The `setInterval` handle was created under real timers (during `initDefaultConfigLoader`), so the subsequent `advanceTimersByTimeAsync` had no captured timer to advance — `dev_branch` stayed `"dev"`.
- **Fix:** Activate fake timers BEFORE `initDefaultConfigLoader` (so `setInterval` is captured) and scope them with `toFake: ["setInterval", "clearInterval"]` so MSW + undici outbound HTTP timers stay real. This matches the working pattern in `test/unit/default-loader-hot-reload.test.ts`.
- **Files modified:** test/integration/config-default-end-to-end.test.ts
- **Commit:** 10a80c0

### [Rule 2 — Robustness] Backfilled defaultLoaderStop into all ShutdownDeps literals

- **Found during:** Task 2.
- **Issue:** Plan asked to extend "every makeShutdown call". The shutdown test file has 4 separate literals; missing any one breaks TypeScript build.
- **Fix:** Added `defaultLoaderStop: vi.fn()` to all 4 literals (ordering test, drain-timeout test, cron-disabled test, double-SIGTERM test). The idempotency test was strengthened with `expect(defaultLoaderStop).toHaveBeenCalledTimes(1)` to prove no double-clearInterval on the singleton.
- **Commit:** ea7db70

## Threat Model — Mitigations Verified

| Threat ID | Disposition | How verified |
|-----------|-------------|--------------|
| T-07-10 (leaked interval handle) | mitigated | shutdown ordering test asserts `defaultLoaderStop` called exactly once in the correct slot; idempotency test asserts call-once on double SIGTERM |
| T-07-11 (first-webhook race) | mitigated | `initDefaultConfigLoader` placed at line 22, BEFORE the `try {}` block (line 27) and `app.listen()` (line 102+) — verified by grep -n |

## Known Stubs

None.

## Notes for Future Work

- Code structure suggestion: the `initDefaultConfigLoader` call sits between `initLogger` and the boot `try {}`. As more "fail-fast singletons" appear (currently: env, logger, defaultLoader), a single `initBootSingletons(env, appLog)` helper in a new `src/boot.ts` would centralise the contract that "these must complete before any I/O". Not urgent — three call sites is below the abstraction threshold.
- The shutdown `ShutdownDeps` interface now lists four lifecycle slots (app, cronHandle, multiQueue, defaultLoaderStop). If a fifth singleton arrives (e.g. health checker stop), consider grouping into a `LifecycleStopper[]` array iterated in order. Same threshold note applies.

## Self-Check: PASSED

- `src/index.ts` contains `initDefaultConfigLoader` (2 hits) and `stopDefaultConfigLoader` (2 hits): FOUND
- `src/shutdown.ts` contains `defaultLoaderStop` (2 hits): FOUND
- `test/integration/config-default-end-to-end.test.ts` exists with 3 it()-blocks: FOUND
- Commits 1f1e441, ea7db70, 10a80c0 present in `git log`: FOUND
- Full `npm run -s test` passes (47 files, 399 tests): FOUND
- `npm run -s build` exits 0: FOUND
