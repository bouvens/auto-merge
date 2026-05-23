---
phase: 07-config-default-fallback
plan: 01
subsystem: config
tags: [env, config-loader, scaffolding, type-extension]
requires: []
provides:
  - "src/env.ts: DEFAULT_CONFIG_RELOAD_MS field"
  - "src/config/loader.ts: ConfigSource type"
  - "src/config/loader.ts: getRepoConfigSource(owner, repo) export"
  - "src/config/loader.ts: loadConfig return widened with source?: ConfigSource"
affects:
  - "src/cascade/orchestrator.ts (backward-compatible destructure preserved)"
  - "src/webhook/pushHandler.ts (backward-compatible destructure preserved)"
tech_stack_added: []
patterns_used:
  - "z.coerce.number().int().positive().default(...) for env scalars"
  - "Parallel Map keyed by `${owner}/${repo}` (mirrors repoConfigCache)"
key_files_created: []
key_files_modified:
  - src/env.ts
  - src/config/loader.ts
  - test/unit/env.test.ts
  - test/integration/config-loader-fetch.test.ts
decisions:
  - "D-04: DEFAULT_CONFIG_RELOAD_MS validated as positive int with default 60_000"
  - "D-08: ConfigSource is a string union: 'repo' | 'file_default' | 'env_default'"
  - "D-09: repoConfigSource is a separate Map; defaultLoader fallback never populates per-sha LRU"
metrics:
  duration_minutes: ~3
  completed: 2026-05-23
  tasks_completed: 1
  files_modified: 4
  commits: 2
---

# Phase 07 Plan 01: Config default fallback — env + ConfigSource scaffolding

Pure type/scaffolding extension: added `DEFAULT_CONFIG_RELOAD_MS` env field and threaded a `source?: ConfigSource` field through `loadConfig`'s return type, backed by a parallel `repoConfigSource` Map and a `getRepoConfigSource` getter — without any fallback logic.

## What was built

- `src/env.ts`: added `DEFAULT_CONFIG_RELOAD_MS: z.coerce.number().int().positive().default(60_000)` directly after `DEFAULT_CASCADE_CONFIG_YAML`. Implicit `Env` type extension via `z.infer`.
- `src/config/loader.ts`:
  - Exported `type ConfigSource = "repo" | "file_default" | "env_default"`.
  - Added module-scope `repoConfigSource = new Map<string, ConfigSource>()` parallel to `repoConfigCache`.
  - Exported `getRepoConfigSource(owner, repo)` getter.
  - Widened `loadConfig` return type to `Promise<{ config?: Config; errors: ConfigError[]; source?: ConfigSource }>`.
  - Cache-hit return now includes `source: "repo"`.
  - Happy-path return: writes `"repo"` into `repoConfigSource` Map and returns `{ ...result, source: "repo" }`.
- `src/config/loader.ts` 404 branch (line 80) and catch branch (line 96) deliberately untouched — that is plan 07-03's surgical scope.
- Tests:
  - `test/unit/env.test.ts`: new `Phase 7 config default fallback env fields (D-04)` describe with 4 cases (default 60000, override 15000, zero rejected, non-numeric rejected).
  - `test/integration/config-loader-fetch.test.ts`: extended happy-path assertions — `result.source === "repo"` and `getRepoConfigSource("o", "r") === "repo"`.

## TDD gates

| Gate     | Commit  | Status |
|----------|---------|--------|
| RED      | 0cc72a1 | 5 expected failures (4 env + 1 missing export) |
| GREEN    | b4fe840 | 38 scoped tests pass; full suite 379 pass |
| REFACTOR | —       | Not needed (minimal scaffolding) |

## Verification

- `npm run -s test -- test/unit/env.test.ts test/integration/config-loader-fetch.test.ts test/unit/config-loader-parse.test.ts` → 38 passed.
- `npm run -s test` (full suite) → 379 passed across 43 test files.
- `npm run -s build` → exit 0 (return-type widening compiles cleanly with existing destructure callsites at `src/cascade/orchestrator.ts:68` and `src/webhook/pushHandler.ts:55`).
- `npm run -s lint` → no new errors/warnings introduced in modified files. Pre-existing `noNonNullAssertion` warnings on `repoConfigCache.set(..., result.config!)` and pre-existing formatter warnings in untouched 404/catch branches are out of scope and were verified to exist on base commit.

## Acceptance criteria

- `grep -n 'DEFAULT_CONFIG_RELOAD_MS' src/env.ts` → 1 match in `Base` z.object. ✓
- `grep -n 'export type ConfigSource' src/config/loader.ts` → 1 match. ✓
- `grep -n 'export function getRepoConfigSource' src/config/loader.ts` → 1 match. ✓
- `grep -nE 'repoConfigSource\.set' src/config/loader.ts` → 1 match (happy-path only). ✓
- `npm run -s build` exits 0. ✓
- Full suite green (379 tests). ✓

## Deviations from Plan

None — plan executed exactly as written. Hook (`comment-blocker`) rejected the originally-drafted multi-line / Phase-referenced inline comments on the parallel Map; collapsed to a single explanatory line on the type declaration and removed the Phase 10 reference from the Map declaration. Decision rationale stays in this SUMMARY and in CONTEXT D-09.

## Known stubs

None — this plan is intentional scaffolding for plans 07-02/07-03. The `source` field is populated only with `"repo"`; `"file_default"` / `"env_default"` variants are produced by future plans per D-08 / D-09. This is documented in the plan's objective and not a stub-in-the-UI sense.

## Commits

| Hash    | Type | Message |
|---------|------|---------|
| 0cc72a1 | test | test(07-01): add RED tests for DEFAULT_CONFIG_RELOAD_MS + ConfigSource |
| b4fe840 | feat | feat(07-01): add DEFAULT_CONFIG_RELOAD_MS + ConfigSource scaffolding |

## Self-Check: PASSED

- `src/env.ts` — modified, present, `DEFAULT_CONFIG_RELOAD_MS` line found.
- `src/config/loader.ts` — modified, present, `ConfigSource`, `getRepoConfigSource`, `repoConfigSource.set` found.
- `test/unit/env.test.ts` — Phase 7 describe block present (4 new cases).
- `test/integration/config-loader-fetch.test.ts` — `getRepoConfigSource` import + 2 new assertions present.
- Commits `0cc72a1` and `b4fe840` present in `git log`.
