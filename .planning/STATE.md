---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Onboarding & Bootstrap
status: executing
last_updated: "2026-05-24T08:32:09.975Z"
last_activity: 2026-05-24
progress:
  total_phases: 6
  completed_phases: 3
  total_plans: 24
  completed_plans: 20
  percent: 50
---

# State: auto-merge

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-05-22 after v1.0 close)

**Core Value:** Любой коммит, попавший в верхнюю ветку каскада, без участия человека доезжает до нижних веток — а если не доезжает (конфликт), команда сразу знает: кто, где, в каком репо, что чинить.

**Current Focus:** Phase 09 — onboarding-webhook-pr-bot

## Current Position

Phase: 09 (onboarding-webhook-pr-bot) — EXECUTING
Plan: 7 of 10
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

**Last action:** Plan 09-06 shipped — `MultiQueue.clearByInstallation` (additive extension of FROZEN multiQueue, +14/-0 lines, slash-boundary prefix match, detach-not-abort semantics). 4 downstream mocks widened. 5 new unit tests + 7 pre-existing pass; full suite 560/560 green.

**Next action:** Continue Phase 9 execution — Plan 09-05 (skipped in Wave 3 order — execute now) or Plan 09-07 next, per wave plan.

---
*State initialized: 2026-05-20*
*Updated: 2026-05-23 — Phase 6 verified passed*
