---
phase: 10-diagnose-endpoint
plan: 02
subsystem: api

tags: [diagnose, octokit, msw, vitest, abort-signal, promise-allsettled]

# Dependency graph
requires:
  - phase: 06-foundation-env-notify-healthcheck
    provides: NotifyHealthChecker.getStatus() — cached slack/telegram statuses
  - phase: 07-config-default-fallback
    provides: loadConfig({octokit, owner, repo, sha, installation_id, notify}) → {config, errors, source}
  - phase: 09-onboarding-webhook-pr-bot
    provides: canonical onboarding PR branch name (auto-merge/onboarding) + config path (.github/auto-merge.yml)
provides:
  - DiagnoseChecks type contracts (per-section payload + ProbeStatus enum) — D-10
  - DiagnoseReport top-level shape (ok, owner, repo, checked_at, checks) — D-10
  - runProbes(deps) orchestrator that composes 6 Octokit endpoints + healthChecker + loadConfig into a single payload
  - safeProbe wrapper: per-call AbortSignal.timeout(3000) + 404-is-data semantics + warn-log on non-404 failures
  - Onboarding hint composition (D-14 decision table)
affects: [10-03-markdown, 10-04-handler, 10-05-integration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Probe orchestrator: safeProbe<T>(name, owner, repo, log, fn) + Promise.allSettled-style allSettled-via-Promise.all of probe results — one probe failure does not poison siblings"
    - "Injection seam pattern: loadConfigFn?: typeof loadConfig defaulted to real import — tests stub without msw-ing the inner Contents endpoint"
    - "Required-permissions as a runProbes dependency (not import) — keeps probes pure, single source of truth lives in handler (D-15)"

key-files:
  created:
    - src/diagnose/types.ts
    - src/diagnose/probes.ts
    - src/diagnose/probes.test.ts
  modified: []

key-decisions:
  - "default_branch resolved via GET /repos/{owner}/{repo} (one extra call) — getRepoInstallation response does not carry it; documented inline."
  - "requiredPermissions injected as RunProbesDeps field rather than imported from handler — keeps probes.ts free of forward-imports and trivially testable."
  - "Branch status mapping: any branch missing → 'error'; all exist + all protected → 'ok'; all exist + at least one unprotected → 'warn'. This treats branch_protection as an operator choice (D-10 'warn' = partial state, not failure)."

patterns-established:
  - "safeProbe wrapper centralises AbortSignal.timeout + 404-vs-real-error discrimination + warn-log structure for any future diagnose probe."
  - "MSW handler override discipline: pass base handlers in one server.use(), per-test overrides in a second server.use() so MSW resolves last-registered = highest priority correctly. Mixing both in a single spread caused silent base-handler wins in the first run."

requirements-completed: [DIAG-01]

# Metrics
duration: ~25min
completed: 2026-05-24
---

# Phase 10 Plan 02: Diagnose probes orchestrator Summary

**Pure-logic runProbes orchestrator that composes 6 Octokit endpoints + healthChecker + loadConfig into a typed DiagnoseChecks payload with per-call 3s timeouts and continue-on-error semantics.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-24T11:56:40Z (approx; STATE last_updated)
- **Completed:** 2026-05-24T12:04:17Z
- **Tasks:** 2
- **Files created:** 3

## Accomplishments

- Shared diagnose type contracts (`src/diagnose/types.ts`) matching D-10 JSON schema exactly — re-exports `ConfigSource` + `NotifyStatus` for downstream plans 10-03/10-04.
- `runProbes(deps)` orchestrator (`src/diagnose/probes.ts`) — installation resolve → parallel probes → assembled `DiagnoseChecks`. Always returns full key-set even when short-circuited on app-not-installed (SC1 invariant).
- 10 msw-driven unit tests covering happy path, app-not-installed short-circuit, permission downgrade diff, file_default fallback, open-PR onboarding warning, /setup hint, branch-protection 404 normalisation, per-call timeout continue-on-error, healthChecker single-invocation, and notify-status derivation.

## Task Commits

1. **Task 1: Define shared types in src/diagnose/types.ts** — `ab6e07b` (feat)
2. **Task 2: Implement src/diagnose/probes.ts + msw-driven tests** — `88d3616` (feat, includes TDD test+impl combined since type-only Task 1 had no run-time tests and Task 2 RED/GREEN converged after the MSW handler-ordering fix)

## Files Created/Modified

- `src/diagnose/types.ts` — ProbeStatus enum + per-section payload types + DiagnoseReport top-level shape; re-exports `ConfigSource` + `NotifyStatus`.
- `src/diagnose/probes.ts` — `runProbes(deps)` orchestrator with safeProbe wrapper, naChecks short-circuit, diffPermissions helper, deriveNotifyStatus, deriveOnboarding (D-14 decision table).
- `src/diagnose/probes.test.ts` — 10 msw-backed unit tests; injects fake `octokitFactory`, fake `healthChecker` (vi.fn), stub `loadConfigFn` for paths that exercise `source='file_default'`/`source=undefined`.

## Decisions Made

- **default_branch resolution:** one extra `GET /repos/{owner}/{repo}` call (run after Step A short-circuit, before parallel probes). Alternative — pass default branch through deps from the handler — rejected because it leaks GitHub-shape concerns into the handler.
- **requiredPermissions injection:** D-15 says the canonical constant lives in handler.ts. To honour that while keeping `probes.ts` pure, the constant is passed as a `RunProbesDeps` field — tests pass a stable inline literal; handler will wire the real constant in Plan 10-04.
- **Notify status derivation:** any `unreachable`/`misconfigured` channel → 'error'; any `pending` → 'warn'; otherwise 'ok'. `n/a` channels are neutral.
- **Branches status:** missing branch → 'error'; all exist + all protected → 'ok'; otherwise 'warn'. Aligns with D-10 'warn = partial state (operator choice)'.

## Deviations from Plan

None — plan executed exactly as written. The plan called for a single Task 2 commit covering both implementation and tests (TDD RED/GREEN within one task per the plan's `tdd="true"` action block). For Task 1, the plan explicitly stated "Type-only file; no runtime tests required" — committed as `feat` with tsc clean as the verification.

## Issues Encountered

- **MSW handler precedence in spread mode:** initial test layout passed both base handlers and per-test overrides in a single `server.use(...happy, override)` call. MSW v2 resolved the **first** matching handler in that combined array as the winner, so overrides did not take effect. Fix: call `server.use(...happy)` first, then `server.use(override)` second — MSW correctly treats the second `use()` registration as higher priority. All 4 failing tests passed after the fix. Documented as an established pattern in the frontmatter so Plans 10-03/10-04/10-05 follow the same discipline.
- **Pre-existing TS2352 errors** in `test/unit/onboarding-onboardRepo.test.ts` remain (already tracked in `deferred-items.md` per Plan 09-10 summary). `tsc --noEmit -p tsconfig.build.json` (src-only) is clean.

## User Setup Required

None — pure-logic plan, no external service configuration.

## Verification

- `npx vitest run src/diagnose/` → 20/20 pass (probes 10 + rateLimit 4 + redact 6)
- `npx vitest run` → 634/634 pass (full suite)
- `npx tsc --noEmit -p tsconfig.build.json` → clean
- `npx biome check src/diagnose/` → clean

## Self-Check: PASSED

- File `src/diagnose/types.ts` — FOUND
- File `src/diagnose/probes.ts` — FOUND
- File `src/diagnose/probes.test.ts` — FOUND
- Commit `ab6e07b` — FOUND in git log
- Commit `88d3616` — FOUND in git log

## Next Phase Readiness

- Plan 10-03 (markdown renderer) can import `DiagnoseReport` + `DiagnoseChecks` from `src/diagnose/types.ts`.
- Plan 10-04 (handler) wires `runProbes(deps)` with the canonical `REQUIRED_PERMISSIONS` constant and the real `getInstallationOctokit` factory.
- No blockers.

---
*Phase: 10-diagnose-endpoint*
*Completed: 2026-05-24*
