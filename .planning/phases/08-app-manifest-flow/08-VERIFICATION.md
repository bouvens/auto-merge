---
phase: 08-app-manifest-flow
verified: 2026-05-23T22:20:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
---

# Phase 08: App Manifest Flow Verification Report

**Phase Goal:** Self-host инсталлятор за <5 минут устанавливает App через one-click manifest вместо ручного создания GitHub App + копирования credentials.

**Verified:** 2026-05-23T22:20:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `/setup/new` gated SETUP_ENABLED, pre-filled manifest; в production endpoint не зарегистрирован | ✓ VERIFIED | `src/server.ts:113` оборачивает `registerSetupRoutes` в `if (deps.env.SETUP_ENABLED)`. `src/setup/manifestForm.ts` рендерит auto-submit форму на `https://github.com/settings/apps/new` с pre-filled JSON manifest, в котором `default_permissions/events/redirect_url/hook_attributes.url` собраны из `SETUP_PUBLIC_URL`. Integration `test/integration/setup-flow.test.ts:126-137` доказывает 404 на все три route'а при `SETUP_ENABLED=false`. Env schema `src/env.ts:48-55` отказывает в boot, если `SETUP_ENABLED=true` без `SETUP_PUBLIC_URL`. |
| 2 | CSRF: tampered/missing state → 400 на /setup/callback через timingSafeEqual | ✓ VERIFIED | `src/setup/csrf.ts:82-87` `safeEqualHex` использует `node:crypto.timingSafeEqual` с pre-check на длину. `src/setup/manifestCallback.ts:138-154` — CSRF gate выполняется ДО любой работы с GitHub API; log не выводит сырые значения (только `has_cookie`/`has_query_state` флаги). Unit-тесты `test/unit/setup-manifest-callback.test.ts:262-304` покрывают все три tampered-кейса (missing state, missing cookie, mismatch) + clearing cookie с Max-Age=0. |
| 3 | Refresh success-страницы не теряет credentials и не вызывает повторный POST conversions | ✓ VERIFIED | `src/setup/manifestCallback.ts:160-222` — persist→render порядок: conversion → `credentials.persist(next)` → `renderSuccessPage(...)` в строго фиксированной последовательности; refresh-path skip'ает conversion через `if (!deps.credentials.exists())` guard и реконструирует payload через `parseCredentialsEnv` чтения с диска. Atomic write через tmp+rename в `src/setup/credentials.ts:69-93`. E2E `test/integration/setup-flow.test.ts:191-219` доказывает: `conversionCalls === 1` после двух последовательных callback'ов с одинаковым state. |
| 4 | Success-страница не выводит сырой PEM/секреты; есть Download .env + redacted-tail | ✓ VERIFIED | `src/setup/manifestCallback.ts:33-46` — `redactTail` возвращает `****` + last 4 chars; `pemTail` стрипает BEGIN/END/whitespace перед хвостом. `renderSuccessPage` передаёт только tails, не сырые секреты. Download form на `/setup/credentials.env` присутствует (line 90). Негативный containment test `test/unit/setup-manifest-callback.test.ts:175-189` ассертит, что raw PEM body и raw webhook_secret НЕ появляются в HTML. Log payload в `setup_completed` (line 200-208) не несёт `pem/client_secret/webhook_secret` — tests:339-341 это подтверждают. Pino redact в `src/log.ts:28-35` покрывает `pem/client_secret/webhook_secret/state` на уровне логгера. |
| 5 | Повторный /setup/new при существующих credentials → warning + recovery, без повторного флоу | ✓ VERIFIED | `src/setup/manifestForm.ts:121-133` — `credentials.exists()` guard выводит `renderWarningPage` без state cookie, если нет `?force=1&confirm=<SETUP_APP_NAME>`. Warning page содержит инструкции recovery + typed-confirm override form. Покрытие: `test/unit/setup-manifest-form.test.ts:259-345` (4 случая: no force, force без confirm, правильный confirm, неправильный confirm) + `test/integration/setup-flow.test.ts:221-245`. |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/setup/routes.ts` | Registry для всех 3 routes | ✓ VERIFIED | 23 LOC, импортирует и регистрирует form/callback/download |
| `src/setup/manifestForm.ts` | GET /setup/new + warning page + override | ✓ VERIFIED | 144 LOC, zod org validation, форма с auto-submit script, warning page с typed-confirm |
| `src/setup/manifestCallback.ts` | GET /setup/callback + credentials download | ✓ VERIFIED | 278 LOC, CSRF→conversion→persist→render порядок, refresh idempotency, download route |
| `src/setup/credentials.ts` | Atomic persist + TTL + stale cleanup | ✓ VERIFIED | tmp+rename с mode 0o600, 1h TTL `setTimeout.unref()`, `checkStaleOnBoot` |
| `src/setup/csrf.ts` | timingSafeEqual + cookie helpers | ✓ VERIFIED | timingSafeEqual с length pre-check, secure flag prod-only |
| `src/setup/manifestSchema.ts` | buildManifest с locked permissions | ✓ VERIFIED | Permissions exactly: contents/pull_requests/checks write, metadata read |
| `src/setup/html.ts` | escapeHtml + jsonForHtmlAttr | ✓ VERIFIED | Table-driven escape (per project convention) |
| `src/env.ts` | SETUP_* envs + cross-field validation | ✓ VERIFIED | SETUP_ENABLED/PUBLIC_URL/APP_NAME/OUTPUT_DIR; superRefine на required PUBLIC_URL |
| `src/log.ts` REDACT_PATHS | Extended for pem/secrets/state | ✓ VERIFIED | Lines 28-35 добавляют pem, client_secret, webhook_secret, state (root + wildcard) |
| `src/server.ts` wiring | Gated registration по SETUP_ENABLED | ✓ VERIFIED | Lines 113-127, defence-in-depth warn если credentials store отсутствует |
| `src/index.ts` boot | stale cleanup + store construction | ✓ VERIFIED | Lines 31-36, mkdir+checkStaleOnBoot+createCredentialsStore только при SETUP_ENABLED |

### Key Link Verification

| From | To | Via | Status |
|------|-----|------|--------|
| `index.ts` | `createCredentialsStore` | flag-guarded constructor | ✓ WIRED |
| `index.ts` | `buildServer(credentials)` | dep injection | ✓ WIRED |
| `server.ts` | `registerSetupRoutes` | `if (env.SETUP_ENABLED)` | ✓ WIRED |
| `manifestCallback.ts` | `getAnonymousOctokit` | factory с overridable injection | ✓ WIRED |
| `manifestCallback.ts` | `credentials.persist` | sync вызов ДО рендера | ✓ WIRED |
| `manifestForm.ts` | `credentials.exists` | duplicate guard | ✓ WIRED |
| Form template | `/setup/callback` redirect URL | `buildManifest` через SETUP_PUBLIC_URL | ✓ WIRED |

### Requirements Coverage

| Requirement | Source Plan | Status | Evidence |
|-------------|-------------|--------|----------|
| SETUP-01 | 08-02 | ✓ SATISFIED | manifestForm.ts + manifestSchema.ts; pre-filled manifest на github.com/settings/apps/new |
| SETUP-02 | 08-03 | ✓ SATISFIED | csrf.ts:safeEqualHex (timingSafeEqual); cookie set в form, validate в callback |
| SETUP-03 | 08-04 | ✓ SATISFIED | manifestCallback.ts строгий порядок CSRF→conversion→persist→render; e2e refresh-idempotency |
| SETUP-04 | 08-04, 08-05 | ✓ SATISFIED | redactTail/pemTail; Download .env через gated cookie; TTL 1h в credentials.ts |
| SETUP-05 | 08-01, 08-06 | ✓ SATISFIED | SETUP_ENABLED gate в server.ts + index.ts; warning page + force=1+confirm override |

Все 5 требований SETUP-01..SETUP-05 полностью имплементированы. Дополнительно REQUIREMENTS.md table (lines 83-87) надо будет переключить с Pending → Done при /gsd-complete-phase.

### Pitfall Mitigation

| Pitfall | Mitigation Found | Location |
|---------|-----------------|----------|
| 1 (CSRF) | timingSafeEqual + length pre-check; presence-only logging | `src/setup/csrf.ts:82-87`, `src/setup/manifestCallback.ts:138-154` |
| 2 (persist-before-render) | Sync `credentials.persist(next)` ДО `renderSuccessPage`; atomic tmp+rename | `src/setup/manifestCallback.ts:189-198`, `src/setup/credentials.ts:69-93` |
| 3 (no raw secrets in HTML) | redactTail/pemTail; негативный containment test | `src/setup/manifestCallback.ts:33-46`, `test/unit/setup-manifest-callback.test.ts:175-189` |
| 12 (duplicate guard) | warning page + `?force=1` + typed-confirm = SETUP_APP_NAME | `src/setup/manifestForm.ts:121-133`, tests 259-345 |

### Anti-Patterns Found

| File | Pattern | Severity |
|------|---------|----------|
| — | (нет) | — |

Скан `TBD/FIXME/XXX` и `TODO/HACK/PLACEHOLDER` в `src/setup/`, `src/env.ts`, `src/log.ts`, `src/server.ts`, `src/index.ts`, `src/auth.ts` — пусто.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Test suite | `npx vitest run` | 55 files, 522/522 passed, 10.5s | ✓ PASS |
| TypeScript | `npx tsc --noEmit` | 0 errors | ✓ PASS |

### Human Verification Required

(Empty — все Success Criteria покрыты автоматическими тестами end-to-end.)

### Gaps Summary

Гэпов не найдено. Фаза 08 полностью достигает декларированного goal'а: self-host оператор через `GET /setup/new` создаёт App в GitHub без ручного копирования credentials; CSRF/refresh/secret-leak/duplicate edge-кейсы покрыты тестами и поведением в коде. Pitfalls 1/2/3/12 митигированы. SETUP_ENABLED=false производственный режим оставляет endpoints незарегистрированными (integration test покрывает 404). Все 522 теста зелёные, TypeScript clean.

---

_Verified: 2026-05-23T22:20:00Z_
_Verifier: Claude (gsd-verifier)_
