---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Onboarding & Bootstrap
status: verifying
last_updated: "2026-05-27T17:35:27.365Z"
last_activity: 2026-05-27
progress:
  total_phases: 6
  completed_phases: 5
  total_plans: 35
  completed_plans: 32
  percent: 83
---

# State: auto-merge

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-05-22 after v1.0 close)

**Core Value:** Любой коммит, попавший в верхнюю ветку каскада, без участия человека доезжает до нижних веток — а если не доезжает (конфликт), команда сразу знает: кто, где, в каком репо, что чинить.

**Current Focus:** Phase 10 — diagnose-endpoint — COMPLETED

## Current Position

Phase: 10 (diagnose-endpoint) — COMPLETED
Plan: 5 of 5 — done
Status: Phase complete — ready for verification
Last activity: 2026-05-27

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
- Plan 10-04: `healthChecker` + octokit factories made MANDATORY on `BuildServerDeps` (D-18) — diagnose route registers unconditionally so the 503-gate inside the handler is the single source of "disabled" state. Pre-existing tests use `test/helpers/diagnose-deps.ts` stub. Making the deps optional would silently disable diagnose in production.
- Plan 10-04: Fastify constructed with `trustProxy: true` (D-20) — required for `req.ip` to honour `X-Forwarded-For` behind Caddy/k8s ingress so per-IP rate-limit keys on the real client. Without trustProxy, all rate-limit traffic shares the proxy socket address as its key.

## Session Continuity

**Last action:** Plan 10-05 shipped — `test/integration/diagnose-endpoint.test.ts` end-to-end coverage of Phase 10 ROADMAP SC1-SC4 via msw + buildServer + app.inject. Boots real wiring (server.ts + handler.ts + probes.ts + markdown.ts) against stubbed GitHub endpoints; 9 scenarios assert JSON envelope + markdown content negotiation (SC1), 503/401 auth gates (SC2), 11th-burst 429 + Retry-After (SC3), planted Slack/Telegram token redaction (SC4), plus a regression scenario for the app-not-installed early-exit invariant. Suite 674/674 green (was 665 → +9 integration tests); biome clean.

**Next action:** Phase 10 verification (`/gsd-verify-phase 10`) → Phase 11 (Release artifacts) planning.

---
*State initialized: 2026-05-20*
*Updated: 2026-05-23 — Phase 6 verified passed*
