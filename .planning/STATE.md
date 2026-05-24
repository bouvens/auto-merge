---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Onboarding & Bootstrap
status: executing
last_updated: "2026-05-24T13:36:30Z"
last_activity: 2026-05-24
progress:
  total_phases: 6
  completed_phases: 3
  total_plans: 24
  completed_plans: 21
  percent: 52
---

# State: auto-merge

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-05-22 after v1.0 close)

**Core Value:** Любой коммит, попавший в верхнюю ветку каскада, без участия человека доезжает до нижних веток — а если не доезжает (конфликт), команда сразу знает: кто, где, в каком репо, что чинить.

**Current Focus:** Phase 09 — onboarding-webhook-pr-bot

## Current Position

Phase: 09 (onboarding-webhook-pr-bot) — EXECUTING
Plan: 8 of 10
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

## Session Continuity

**Last action:** Plan 09-07 shipped — `MultiChannel` gains optional `suppressionCheck` 2nd ctor arg. queue_overflow id extracted from `key` prefix (D-21); `NotifyEvent` union FROZEN. 11 unit tests; full suite 589/589 green. Pre-existing TS2352 in `onboarding-onboardRepo.test.ts` logged in `deferred-items.md`.

**Next action:** Plan 09-08 — onboarding handler (p-limit batch + fire-and-forget + aggregate summary).

---
*State initialized: 2026-05-20*
*Updated: 2026-05-23 — Phase 6 verified passed*
