---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Onboarding & Bootstrap
status: executing
last_updated: "2026-05-24T12:04:17Z"
last_activity: 2026-05-24
progress:
  total_phases: 6
  completed_phases: 4
  total_plans: 29
  completed_plans: 26
  percent: 70
---

# State: auto-merge

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-05-22 after v1.0 close)

**Core Value:** Любой коммит, попавший в верхнюю ветку каскада, без участия человека доезжает до нижних веток — а если не доезжает (конфликт), команда сразу знает: кто, где, в каком репо, что чинить.

**Current Focus:** Phase 10 — diagnose-endpoint

## Current Position

Phase: 10 (diagnose-endpoint) — EXECUTING
Plan: 3 of 5
Status: Ready to execute
Last activity: 2026-05-24

## Last Milestone

- **v1.0 MVP** — Phases 1-5 — 32 plans — 344/344 tests — audit PASSED
- See: `.planning/MILESTONES.md` and `.planning/milestones/v1.0-ROADMAP.md`

## Accumulated Context

### Open Blockers

- Нет.

### Open Todos (Cross-Milestone)

- Human smoke-test checkpoint Docker-образа на реальном VPS / k8s (production-pilot).

### v1.1 Key Decisions (carry into plan-phase)

- Onboarding runs **inline в webhook handler**, НЕ в MultiQueue (Anti-Pattern 1 в research/ARCHITECTURE.md).
- ConfigLoader DEFAULT fallback: memoise на module load, НЕ per-sha LRU; hook sites — loader.ts:80 (file-missing) + loader.ts:96 (404-catch).
- Manifest credentials persist **до** рендера HTML (Pitfall 2: code single-use + 1h TTL = unrecoverable App).
- `installation_repositories` batched payload → p-limit(2) standalone semaphore, всё в одном webhook handler fire-and-forget; **MultiQueue не используется** (Phase 9 reinterpretation of SC2, см. 09-CONTEXT.md <sc_reinterpretations>).
- Boot notify check: format errors → fail-fast, connectivity errors → degraded mode (Pitfall 11).
- v1.0 components FROZEN: cascade/, MultiQueue, pushHandler, dispatch, notify dispatcher, cron safetyNet, shutdown, config/schema.ts.
- Plan 10-02: `requiredPermissions` injected as `runProbes` dependency (not imported from handler) — keeps `probes.ts` free of forward-imports; handler keeps canonical constant per D-15.
- Plan 10-02: MSW handler ordering rule — base handlers via one `server.use(...happy)` call, per-test overrides via a second `server.use(override)` call; spreading both into a single `server.use()` resolves the first-in-array as winner and silently breaks override intent.

## Session Continuity

**Last action:** Plan 10-02 shipped — `src/diagnose/types.ts` (D-10 contracts) + `src/diagnose/probes.ts` (runProbes orchestrator: safeProbe wrapper, Promise.allSettled-style parallelism, per-call AbortSignal.timeout(3000), 404-is-data semantics, app-not-installed short-circuit returning full key-set as n/a) + `src/diagnose/probes.test.ts` (10 msw-driven scenarios). Full suite 634/634 green; biome clean; tsc clean (pre-existing TS2352 in `onboarding-onboardRepo.test.ts` still in deferred-items.md).

**Next action:** Plan 10-03 — Markdown renderer for DiagnoseReport (pure function + snapshot tests).

---
*State initialized: 2026-05-20*
*Updated: 2026-05-23 — Phase 6 verified passed*
