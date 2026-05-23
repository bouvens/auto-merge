---
phase: 07-config-default-fallback
plan: 02
subsystem: config
tags: [defaultLoader, closure-factory, hot-reload, mtime-polling, fail-fast]
requires:
  - "src/config/loader.ts: parseConfig (pure helper)"
  - "src/config/loader.ts: ConfigSource type (07-01)"
  - "src/env.ts: DEFAULT_CASCADE_CONFIG_FILE/YAML, DEFAULT_CONFIG_RELOAD_MS"
  - "src/shutdown.ts: makeExitStub (test-friendly exit injection)"
provides:
  - "src/config/defaultLoader.ts: createDefaultConfigLoader factory"
  - "src/config/defaultLoader.ts: initDefaultConfigLoader / getDefaultConfig / stopDefaultConfigLoader (module singleton trio)"
  - "src/config/defaultLoader.ts: DefaultLoader interface"
affects: []
tech_stack_added: []
patterns_used:
  - "Closure factory + private mutable cache (mirrors src/notify/healthCheck.ts)"
  - "Module singleton trio (init/get/stop) wrapping the factory"
  - "Injectable exit stub (makeExitStub) for fail-fast tests"
  - "setInterval(...).unref() — does not hold event loop at shutdown"
  - "mtime-gated polling — statSync first, readFileSync only on bump"
key_files_created:
  - src/config/defaultLoader.ts
  - test/unit/default-loader-parse.test.ts
  - test/unit/default-loader-hot-reload.test.ts
key_files_modified: []
decisions:
  - "D-01/D-03: fail-fast on boot ENOENT or invalid YAML via injected exit + log.fatal"
  - "D-02: FILE+YAML both set → FILE wins; one-time log.warn default_config_yaml_ignored"
  - "D-04: setInterval(tick, DEFAULT_CONFIG_RELOAD_MS).unref(); mtime-gated tick body"
  - "D-05: YAML inline never starts an interval (restart-only)"
  - "D-06/D-07: reload-fail (invalid YAML) and file-deleted both retain last-known-good and log.error"
  - "R-7 (test design): ESM live-binding makes vi.spyOn(fs, …) unsupported; cases 4+5 verify behavior via log-event assertions instead"
metrics:
  duration_minutes: ~12
  completed: 2026-05-23
  tasks_completed: 3
  files_created: 3
  commits: 3
---

# Phase 07 Plan 02: defaultLoader module + unit tests

Standalone `src/config/defaultLoader.ts` implementing the closure factory + module singleton trio for org-default config fallback. Boot-time loads FILE (preferred) or YAML inline through the shared `parseConfig` helper with fail-fast on invalid/missing input; hot-reload via `setInterval(...).unref()` for FILE source only, with last-known-good retention on tick failure.

No consumers yet — plan 07-03 will import `getDefaultConfig` from `src/config/loader.ts`'s 404/catch branches, plan 07-04 will call `initDefaultConfigLoader` in `src/index.ts` and `stopDefaultConfigLoader` in `src/shutdown.ts`.

## What was built

### `src/config/defaultLoader.ts` (NEW, 148 LOC)

- `createDefaultConfigLoader(env, log, exit?)` factory:
  - Inputs: `{ DEFAULT_CASCADE_CONFIG_FILE?, DEFAULT_CASCADE_CONFIG_YAML?, DEFAULT_CONFIG_RELOAD_MS }`, injected `pino.Logger`, optional `exit` (default `process.exit`).
  - Both env set → `log.warn { event: "default_config_yaml_ignored" }` once, then proceeds with FILE (D-02).
  - FILE path: `statSync` + `readFileSync` wrapped in try/catch → fail-fast on ENOENT (`event: "default_config_file_missing_at_boot"`, D-03). `parseConfig` errors → fail-fast (`event: "default_config_invalid"`, `source: "file"`, D-01). On success: stores `{ config, source: "file_default" }`, records `lastMtime`, starts `setInterval(tick, RELOAD_MS).unref()` (D-04).
  - YAML inline path: `parseConfig` → fail-fast on errors (`event: "default_config_invalid"`, `source: "env"`). No interval started (D-05).
  - Neither set: `current = undefined`, no interval, no logs.
- `tick()` closure (FILE only): `statSync` → return if `mtimeMs === lastMtime` (cheap no-op). Otherwise `readFileSync` + `parseConfig`. Invalid → `log.error default_config_reload_failed`, retain last-known-good, do NOT update `lastMtime` (D-06). Throw (ENOENT mid-flight) → `log.error default_config_file_missing`, retain (D-07). Success → swap + `log.info default_config_reloaded { path, mtime }`.
- `stop()`: `clearInterval(handle); handle = undefined;` — idempotent.
- Module singleton trio: `initDefaultConfigLoader / getDefaultConfig / stopDefaultConfigLoader` over a module-scoped `instance`. `getDefaultConfig` returns `undefined` when no instance (per CONTEXT "neither set" path — plan 07-03 treats undefined as "no fallback").
- `DefaultSource` is `Exclude<ConfigSource, "repo">` — only the two fallback variants belong to this module.

### `test/unit/default-loader-parse.test.ts` (NEW, 154 LOC, 6 cases)

| # | Case | Asserts |
|---|------|---------|
| 1 | FILE + valid YAML | `get().source === "file_default"`, config matches, `info` with `event: default_config_loaded, source: file_default, path` |
| 2 | YAML inline + valid | `get().source === "env_default"`, no `path` in log, `stop()` no-op |
| 3 | Both set | FILE wins, `warn` called exactly once with `default_config_yaml_ignored` |
| 4 | FILE + missing path | `exit(1)` thrown via `makeExitStub`, `fatal` with `default_config_file_missing_at_boot` |
| 5 | YAML + zod-invalid | `exit(1)`, `fatal` with `default_config_invalid, source: env, errors: [...]` |
| 6 | Neither | `get() === undefined`, `stop()` no-op, no `info` calls |

### `test/unit/default-loader-hot-reload.test.ts` (NEW, 150 LOC, 5 cases)

| # | Case | Asserts |
|---|------|---------|
| 1 | mtime bump + valid swap | `config.dev_branch` flips `dev → develop`, `info` with `default_config_reloaded` |
| 2 | mtime bump + invalid YAML | config unchanged, `error` with `default_config_reload_failed` |
| 3 | file deleted mid-flight | config unchanged, `error` with `default_config_file_missing` |
| 4 | mtime unchanged | no `default_config_reloaded` log, config unchanged |
| 5 | stop() then bump | no `default_config_reloaded` log after stop(), config unchanged |

Uses `vi.useFakeTimers()` + real `utimesSync` with absolute future Dates to push mtime past `lastMtime` regardless of fake-timer state.

## TDD gates

Plan 07-02 has `type: execute` (not `type: tdd`), so the gate sequence per-task:

| Task | Gate         | Commit  | Note |
|------|--------------|---------|------|
| 1    | implementation | 6c9d2eb | Module first (tests in tasks 2 & 3 per plan instruction) |
| 2    | tests (GREEN)  | 243a84d | All 6 boot cases pass on first run |
| 3    | tests (GREEN)  | fa32f19 | All 5 hot-reload cases pass after one revision (see Deviations) |

## Verification

- `npx vitest run test/unit/default-loader-parse.test.ts` → 6 passed.
- `npx vitest run test/unit/default-loader-hot-reload.test.ts` → 5 passed.
- `npx vitest run` (full suite) → **390 passed across 45 test files** (was 379/43 at end of 07-01; +11 = exactly our 6+5 new cases, +2 new files).
- `npm run -s build` → exit 0.
- `npx biome check src/config/defaultLoader.ts test/unit/default-loader-parse.test.ts test/unit/default-loader-hot-reload.test.ts` → clean.

## Acceptance criteria

- `test -f src/config/defaultLoader.ts` ✓
- `grep -c '^export function createDefaultConfigLoader' src/config/defaultLoader.ts` → 1 ✓
- `grep -c '^export function initDefaultConfigLoader' src/config/defaultLoader.ts` → 1 ✓
- `grep -c '^export function getDefaultConfig' src/config/defaultLoader.ts` → 1 ✓
- `grep -c '^export function stopDefaultConfigLoader' src/config/defaultLoader.ts` → 1 ✓
- `grep -nE 'setInterval\(.*\)' src/config/defaultLoader.ts && grep -nE '\.unref\(\)' src/config/defaultLoader.ts` → both present, interval declared once ✓
- `grep -c 'clearInterval' src/config/defaultLoader.ts` → 1 ✓
- `grep -v '^[[:space:]]*//' src/config/defaultLoader.ts | grep -c 'console\.\(error\|log\)'` → 0 (injected pino only) ✓
- Each test file has ≥6 / ≥5 `it(` declarations ✓
- Build + lint + full suite all green ✓

## Deviations from Plan

**1. [Rule 1 — Test infrastructure] Cases 4 + 5 in hot-reload tests cannot use `vi.spyOn(fs, ...)`**
- **Found during:** Task 3 first test run.
- **Issue:** `vi.spyOn(fs, "readFileSync" | "statSync")` throws `TypeError: Cannot redefine property` under Node ESM — module namespaces are not configurable (vitest documents this limitation).
- **Fix:** Reworked cases 4 + 5 to assert observable behavior via the injected logger instead:
  - Case 4 ("mtime unchanged"): advance 3× the interval; assert absence of any `default_config_reloaded` log event and that `get().config` is unchanged.
  - Case 5 ("stop halts ticks"): after `loader.stop()`, write a new valid file + bump mtime; advance 2× the interval; assert absence of `default_config_reloaded` and that `get().config` is unchanged.
- **Why behavior-equivalent:** The tick body only writes `info(... event: default_config_reloaded ...)` on a successful swap (which requires both a `readFileSync` and a `parseConfig` success). Absence of that log is a strict superset of "no readFileSync happened on a changed file". For the stop case, absence of the log after a real file change confirms the interval is no longer firing — which is the contract `stop()` exists to provide.
- **Plan note:** The plan itself foresaw this (`<action>` note in Task 3: "if it doesn't intercept, switch to `vi.mock` with manual `vi.importActual`"). I chose the simpler equivalent-observation path over `vi.mock` to avoid module-cache pollution across test files.
- **Files modified:** `test/unit/default-loader-hot-reload.test.ts` (replaced the two spy-based assertions with log-event assertions; removed the unused `* as fs` import).
- **Commit:** fa32f19.

**2. [Hook constraint] Two consecutive `//` comment lines blocked by comment-blocker hook**
- **Found during:** Task 1 first Write.
- **Issue:** Project's `comment-blocker` hook rejects ≥2 consecutive `//` lines.
- **Fix:** Collapsed the 2-line "Module singleton trio" comment into a single WHY-line. Also moved the `// sync I/O by design — overlap-free at 60s cadence; parseConfig is pure (R-3)` comment from inside the tick body to immediately above the `tick` declaration so the inline `// D-06` and `// D-07` comments inside the body don't form a 2-line run with it.
- **Files modified:** `src/config/defaultLoader.ts` (pre-commit, never landed in a separate commit).

No other deviations. No architectural changes. No auth gates encountered.

## Known stubs

None. The module is intentionally consumer-free (callers added in plans 07-03 and 07-04). That is the explicit goal stated in the plan's `<objective>`, not a stub.

## Threat flags

None new. The two STRIDE entries the plan registered (`T-07-03` tampering, `T-07-04` info-disclosure, `T-07-05` DoS-tick-I/O, `T-07-06` reload-fail-crash-loop) are all mitigated by code shipped in this plan:

- T-07-03: `parseConfig` + `ConfigSchema.strict()` rejects unknown keys.
- T-07-04: log payloads contain only `path`, `mtime`, `event`, `source`, and `parseConfig` `errors` (field-name level). Raw `text` / raw `env.DEFAULT_CASCADE_CONFIG_YAML` is never logged.
- T-07-05: tick uses sync `statSync` + conditional `readFileSync`; the cheap no-op on unchanged mtime keeps steady-state cost sub-millisecond.
- T-07-06: D-06/D-07 retain last-known-good; the only crash path is boot-time (D-03/D-01), which is the deliberately chosen failure mode for deploy bugs.

## Commits

| Hash    | Type | Message |
|---------|------|---------|
| 6c9d2eb | feat | feat(07-02): add defaultLoader module — closure factory + singleton trio |
| 243a84d | test | test(07-02): cover defaultLoader boot/parse paths (6 cases) |
| fa32f19 | test | test(07-02): cover defaultLoader hot-reload tick paths (5 cases) |

## Self-Check: PASSED

- `src/config/defaultLoader.ts` — present (148 LOC), exports `createDefaultConfigLoader`, `initDefaultConfigLoader`, `getDefaultConfig`, `stopDefaultConfigLoader`, `DefaultLoader`.
- `test/unit/default-loader-parse.test.ts` — present, 6 `it(` declarations.
- `test/unit/default-loader-hot-reload.test.ts` — present, 5 `it(` declarations.
- Commits 6c9d2eb, 243a84d, fa32f19 all present in `git log`.
- Full suite green (390/390).
