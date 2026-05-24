# Phase 10: Diagnose endpoint - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-24
**Phase:** 10-Diagnose endpoint
**Areas discussed:** Probe API-call set + concurrency, Pre-handler chain order, Response shape + markdown, Composition with Phase 7/9 hints

---

## Probe API-call set + concurrency + per-step failure handling

| Option | Description | Selected |
|--------|-------------|----------|
| All-settled parallel + continue-on-error | Step 1 `apps.getRepoInstallation` (404→app_installed=false+skip); Step 2 parallel Promise.allSettled per-call timeout 3000ms (`getInstallation` permissions+events, `loadConfig` source+config, per-branch `getBranch`+`getBranchProtection`, `getContent` `.github/auto-merge.yml`, `pulls.list` onboarding head). Continue-on-error, per-probe status. Reuse `getInstallationOctokit`. | ✓ |
| Sequential probes, short-circuit | Простота vs частичный snapshot, не покрывает SC1 («JSON со всеми полями»). | |
| Cached-only (no GitHub API hits) | Быстрее, но branch existence/protection не в кэше — не покрывает SC1. | |

**User's choice:** All-settled parallel + continue-on-error
**Notes:** Закреплено в D-04..D-06 + D-15. Соответствует SC1.

---

## Pre-handler chain order + rate-limit реализация

| Option | Description | Selected |
|--------|-------------|----------|
| 503-gate → rate-limit → bearer-auth, собственный LRU | DIAGNOSE_TOKEN=undefined → 503 первой проверкой (не тратим RL-budget). RL перед auth защищает timingSafeEqual CPU от brute-force; 429 сам по себе не leak'ит секреты. Собственный LRU `Map<ip,{count,resetAt}>` через `LRUCache(max:10_000, ttl:60_000)`. trustProxy=true в Fastify. | ✓ |
| 503 → auth → rate-limit | «No timing leak» от 429-enum, но открывает CPU-amplification на timingSafeEqual. | |
| @fastify/rate-limit plugin | Лишний dep — единственный RL-endpoint в проекте; противоречит v1.0 «direct-impl» стилю. | |

**User's choice:** 503-gate → rate-limit → bearer-auth, собственный LRU
**Notes:** Закреплено в D-07..D-09 + D-20 (trustProxy).

---

## Response shape + markdown rendering

| Option | Description | Selected |
|--------|-------------|----------|
| Sectioned JSON c overall.status, markdown внутри diagnose/ | `{ok, owner, repo, checked_at, checks: {app_installed, app_permissions, config, branches, notify, onboarding}}`, каждый check `status: 'ok'|'warn'|'error'|'n/a'` + detail. Markdown — pure-function `renderMarkdown(report)` без библиотек, snapshot-tested. HTTP 200 даже при ok=false. | ✓ |
| Flat JSON по полям из SC1 | Литерально совпадает с SC1, но сложнее уложить per-branch detail и missing-permissions diff. | |
| RFC 7807 problem+json + checks array | Overkill — никто в v1.0 не использует 7807, ломает стиль. | |

**User's choice:** Sectioned JSON c overall.status, markdown внутри diagnose/
**Notes:** Закреплено в D-10..D-12. JSON-схема финализирована в CONTEXT.md.

---

## Композиция с Phase 7/9: hints при missing config / open onboarding PR

| Option | Description | Selected |
|--------|-------------|----------|
| Probe `.github/auto-merge.yml` на default branch + open PR scan; hints в onboarding секции | `getContent('.github/auto-merge.yml', ref=default_branch)` → config_present; `pulls.list(state=open, head=:auto-merge/onboarding)` → open_pr. `loadConfig().source` отдельно. Композиция: config_present=false + source=undefined + open_pr → onboarding.status=warn; иначе error/ok per matrix. Template-strings не инспектируем. | ✓ |
| Только loadConfig().source | Минимально, но теряем «PR уже открыт, ждёт мержа» hint; не покрывает ROADMAP «composes Phase 9 outputs». | |
| Inspect template strings + diff файла с templates.ts | Scope creep — drift detection, отдельная фаза vNext. | |

**User's choice:** Probe `.github/auto-merge.yml` + open PR scan
**Notes:** Закреплено в D-13..D-14. Композиционная matrix явно прописана.

---

## Claude's Discretion

- Точная сигнатура `compareBearer` (D-09) — inline vs export.
- Accept-header parsing ordering (до или после auth/rate-limit) — выбрана симметрия «после».
- Shape `app_permissions.missing` — массив строк vs объект `{key, required, actual}`.
- Notify detail в JSON — только enum vs объект с `last_checked_at`.
- Markdown details (точные emoji, заголовки) — финализирует snapshot planner.
- App-level Octokit pattern (`probot.octokit` vs `app.octokit` vs minted-on-demand) — planner выберет.
- msw test fixtures — по образцу `test/integration/*-install.test.ts`.

## Deferred Ideas

- **Drift detection** — diff `.github/auto-merge.yml` в репо vs `src/onboarding/templates.ts`. vNext.
- **Per-installation aggregate diagnose** — `GET /diagnose/installations/{id}` bulk-snapshot. vNext.
- **Cron-driven health monitoring** — periodic auto-diagnose + alert. Out of scope v1.1.
- **Force-refresh notify cache** — `?refresh=notify` query. Если operator-feedback потребует.
- **`@fastify/accepts`** — proper content-negotiation. Если появится третий формат.
- **OpenAPI schema export** — для downstream tooling. vNext.
