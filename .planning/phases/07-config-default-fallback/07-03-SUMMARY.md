---
phase: 07-config-default-fallback
plan: 03
subsystem: config
tags: [config-loader, default-fallback, hook-sites, integration-test, observability]
requires:
  - "src/config/loader.ts: ConfigSource type, repoConfigSource Map (07-01)"
  - "src/config/defaultLoader.ts: getDefaultConfig export (07-02)"
provides:
  - "src/config/loader.ts: file-missing-branch consumes getDefaultConfig fallback"
  - "src/config/loader.ts: catch-404 branch consumes getDefaultConfig fallback (err.status === 404)"
  - "src/config/loader.ts: config_resolved INFO log on every cache-miss across 3 sources"
  - "test/integration/config-loader-default-fallback.test.ts: 6-case precedence + log assertions"
affects:
  - "src/cascade/orchestrator.ts (return-shape backward-compatible — no callsite change)"
  - "src/webhook/pushHandler.ts (return-shape backward-compatible — no callsite change)"
tech_stack_added: []
patterns_used:
  - "Octokit err.status === 404 discriminator (R-6)"
  - "Structured pino log with stable event field"
  - "MSW + Octokit integration test with per-test handler overrides"
  - "vi.spyOn(log, 'info') for log-shape assertions"
key_files_created:
  - test/integration/config-loader-default-fallback.test.ts
key_files_modified:
  - src/config/loader.ts
decisions:
  - "D-09 enforced: default fallback never enters per-sha LRU; only repoConfigCache + repoConfigSource Maps"
  - "D-10 enforced: config_resolved INFO log fires on cache-miss only — early cache-hit return at L75 deliberately silent"
  - "R-6 enforced: only status === 404 triggers catch-branch fallback; 403/5xx keep existing failure path"
metrics:
  duration_minutes: ~10
  completed: 2026-05-23
  tasks_completed: 2
  files_modified: 1
  files_created: 1
  commits: 2
---

# Phase 07 Plan 03: Wire default fallback into loader.ts at both 404 sites

Smallest surgical edit that makes default fallback live for production traffic. After this plan, defaults set at boot become observable on every webhook for repos without `.github/auto-merge.yml`. Plan executed as written; no architectural deviations.

## What was built

### `src/config/loader.ts` (modified)
- Added imports: `import { log } from "../log.js"` and `import { getDefaultConfig } from "./defaultLoader.js"`.
- **Hook site #1** (file-missing branch, was lines 80-93): before the existing failure path, attempts `getDefaultConfig()`. If a fallback is present, populates `repoConfigCache` + `repoConfigSource` (D-09), logs `config_resolved`, and returns `{ config, errors: [], source: fallback.source }`. Otherwise, original Check Run + notify path is unchanged.
- **Hook site #2** (catch block, was lines 96-110): extracts `(err as { status?: number }).status` and only attempts fallback when `status === 404` (R-6 — Octokit's documented HttpError shape). 403/5xx and any other thrown error keep the existing failure path verbatim.
- **Happy-path log** added before final `return` (around line 167-170): `log.info({ event: "config_resolved", owner, repo, source: "repo" }, "config")`. Cache-hit early-return at line 75-77 deliberately has no log — that's the no-spam-on-hit behavior of D-10.

### `test/integration/config-loader-default-fallback.test.ts` (new, 6 cases)
- **Case 1**: repo 200 + no default → `source: "repo"` baseline, `config_resolved` logged once.
- **Case 2**: repo file-missing branch (empty content) + FILE default initialised → `source: "file_default"`, `getRepoConfig` populated for notify resolver, NO Check Run POST, log fires with correct source.
- **Case 3**: repo 404 (catch branch) + YAML default → `source: "env_default"`, NO Check Run POST, log fires with correct source.
- **Case 4**: repo 404 + no default → existing failure path intact (errors + Check Run POST received).
- **Case 5**: repo 403 + default initialised → fallback NOT applied (status !== 404), Check Run POST received.
- **Case 6**: same `(owner, repo, sha)` repo-200 load twice → second call is cache-hit and does NOT add to `config_resolved` log count; only one Contents API request issued.

Test setup uses MSW handler overrides per test (no shared default handlers), spies `log.info` to assert log shape, uses unique per-test `sha` values to avoid per-sha LRU cross-talk, and tears down the `defaultLoader` singleton in `afterEach` via `stopDefaultConfigLoader()`.

## TDD gates

| Gate     | Commit   | Status |
|----------|----------|--------|
| RED      | cb2a36b  | 4 expected failures in 6-case test file (defaults not wired yet); 2 baseline cases passing |
| GREEN    | 98f8a52  | All 6 new cases green; full suite 396 pass / 0 fail |
| REFACTOR | —        | Not needed (surgical edits, no duplication) |

## Verification

- `npm run -s build` → exit 0.
- `npm run -s test -- test/integration/config-loader-default-fallback.test.ts` → 6/6 pass.
- `npm run -s test -- test/integration/config-loader-default-fallback.test.ts test/integration/config-loader-fetch.test.ts test/unit/config-loader-parse.test.ts test/integration/check-run-on-invalid.test.ts` → 14/14 pass.
- `npm run -s test` (full suite) → 396 passed across 46 test files.
- `npx biome check --write src/config/loader.ts test/integration/config-loader-default-fallback.test.ts` → format auto-fixed; 2 remaining warnings are pre-existing `noNonNullAssertion` on `result.config!` at lines 164-165 (untouched by this plan).

## Acceptance criteria

- `grep -c 'getDefaultConfig' src/config/loader.ts` → 3 (import + 2 hook sites). ✓
- `grep -cE 'cache\.set\(.*fallback' src/config/loader.ts` → 0 (default never enters per-sha LRU). ✓
- `grep -c 'event: "config_resolved"' src/config/loader.ts` → 3 (file-missing fallback, catch-404 fallback, repo happy-path). ✓
- `grep -cE '\(err as \{ status\?: number \}\)\.status' src/config/loader.ts` → 1 (catch discriminator). ✓
- `grep -cE "^\s+it\(" test/integration/config-loader-default-fallback.test.ts` → 6. ✓
- Existing `test/integration/config-loader-fetch.test.ts` still green (no default initialised → behavior identical). ✓
- Existing `test/integration/check-run-on-invalid.test.ts` still green (parseConfig errors path unchanged). ✓
- Full suite green (396 tests). ✓

## Deviations from Plan

None — plan executed exactly as written. Biome auto-formatter reflowed `void deps.notify?.notify({...}).catch(...)` chains to multi-line during the post-implementation `biome check --write` pass; behavior unchanged. The pre-existing two `noNonNullAssertion` warnings on `result.config!` (lines 164-165) were left in place — they are scoped to plan 07-01's territory and out of scope per Rule 4 (architectural-only changes should not be opportunistically introduced).

A comment-blocker hook rejected an initially-drafted two-line WHY comment in the hook-site #1 block; collapsed to a single-line explanation, semantics preserved. Source-of-truth rationale (D-09 / Anti-Pattern 3) remains in CONTEXT.md and in this SUMMARY.

## Known stubs

None — this plan is the production cutover for DEF-03. Plan 07-04 will wire `initDefaultConfigLoader` + `stopDefaultConfigLoader` into `index.ts` boot and `shutdown.ts` teardown so the singleton actually exists in deployed binaries; until then `getDefaultConfig()` returns `undefined` at runtime and the new hook-site branches are inert (existing failure paths run). This is the deliberate sequence in CONTEXT.md "Phase plan ordering".

## Commits

| Hash    | Type | Message |
|---------|------|---------|
| cb2a36b | test | test(07-03): add RED integration tests for default fallback precedence |
| 98f8a52 | feat | feat(07-03): wire defaultLoader fallback into loader.ts at both 404 sites |

## Threat Flags

None — all new surface stays within the threat register established in 07-03-PLAN.md (`T-07-07` catch discriminator, `T-07-08` log redaction, `T-07-09` per-sha LRU isolation). All three mitigations were implemented and grep-verified.

## Self-Check: PASSED

- `src/config/loader.ts` — modified; imports `log` and `getDefaultConfig`; both hook sites wired; 3 `config_resolved` log call sites; 0 `cache.set` with fallback.
- `test/integration/config-loader-default-fallback.test.ts` — created; 6 `it(...)` cases present; passes locally.
- Commits `cb2a36b` and `98f8a52` present in `git log --oneline`.
