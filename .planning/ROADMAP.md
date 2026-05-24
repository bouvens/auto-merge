# Roadmap: auto-merge

**Core Value:** Любой коммит, попавший в верхнюю ветку каскада, без участия человека доезжает до нижних веток — а если не доезжает (конфликт), команда сразу знает: кто, где, в каком репо, что чинить.

## Milestones

- ✅ **v1.0 MVP** — Phases 1-5 (shipped 2026-05-22) — [`milestones/v1.0-ROADMAP.md`](milestones/v1.0-ROADMAP.md)
- 🚧 **v1.1 Onboarding & Bootstrap** — Phases 6-11 (planning 2026-05-22)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-5) — SHIPPED 2026-05-22</summary>

- [x] Phase 1: Foundation (7/7 plans) — completed 2026-05-20
- [x] Phase 2: Cascade Engine (8/8 plans) — completed 2026-05-21
- [x] Phase 3: Reliability & Operations (7/7 plans) — completed 2026-05-21
- [x] Phase 4: Notifications & Release (5/5 plans) — completed 2026-05-22
- [x] Phase 5: Address v1.0 tech debt (5/5 plans) — completed 2026-05-22

See [`milestones/v1.0-ROADMAP.md`](milestones/v1.0-ROADMAP.md) for full details.

</details>

### v1.1 Onboarding & Bootstrap

- [ ] **Phase 6: Foundation — env + notify healthCheck** — Boot-time notify probes + new env vars, `/readyz` extension, fail-fast format vs degraded connectivity
- [x] **Phase 7: Config DEFAULT fallback** — `DEFAULT_CASCADE_CONFIG_FILE` + `DEFAULT_CASCADE_CONFIG_YAML` org-default with precedence (repo > file > env) and hot-reload for file path (completed 2026-05-23)
- [ ] **Phase 8: App Manifest flow** — `/setup/new` + `/setup/callback` one-click GitHub App creation with CSRF state, persist-before-render, duplicate-setup guard
- [x] **Phase 9: Onboarding webhook + PR-bot** — `installation` / `installation_repositories` subscribers open idempotent draft PR with `.github/auto-merge.yml` + dispatch workflow, respect branch protection (completed 2026-05-24)
- [ ] **Phase 10: Diagnose endpoint** — `GET /diagnose/{owner}/{repo}` with bearer-token auth, rate-limit, redaction; composes Phase 6/7/9 outputs
- [ ] **Phase 11: Release artifacts** — Multi-arch GHCR image (matrix-per-arch + cosign keyless + SLSA provenance), Helm chart (single-replica guard, `existingSecretName`), Fly.io / Render / Compose+Caddy templates, README rewrite

## Phase Details

### Phase 6: Foundation — env + notify healthCheck
**Goal**: Operator получает чёткий сигнал на boot: malformed token = fail-fast, transient outage = degraded; новые env vars зафиксированы и валидируются zod.
**Depends on**: Nothing (foundation for v1.1)
**Requirements**: DIAG-05, DIAG-06, DIAG-07
**Success Criteria** (what must be TRUE):
  1. При запуске с битым форматом `SLACK_WEBHOOK_URL` / `TELEGRAM_BOT_TOKEN` инстанс падает fail-fast с понятной zod-ошибкой ещё до того, как Fastify слушает порт
  2. При запуске со Slack/Telegram outage (5xx/timeout) инстанс стартует в degraded mode и `/readyz` возвращает 200 с `notify_status: { slack: "unreachable", telegram: "ok" }`
  3. С `NOTIFY_HEALTHCHECK_REQUIRED=true` тот же outage → `/readyz` отдаёт 503 (strict mode opt-in)
  4. Результаты notify health-check кэшируются 15 минут — 100 hits на `/readyz` за минуту = максимум 1 upstream-вызов Slack/Telegram per channel
**Plans**: 4 plans
- [ ] 06-01-PLAN.md — Extend env.ts with v1.1 vars + superRefine + fail-fast tests
- [ ] 06-02-PLAN.md — Create src/notify/healthCheck.ts (probes + TTL cache + single-flight) + msw harness + unit tests
- [ ] 06-03-PLAN.md — Extend BuildServerDeps.readyzFn return type with body; merge into /readyz response
- [ ] 06-04-PLAN.md — Wire healthChecker in src/index.ts + end-to-end /readyz integration test

### Phase 7: Config DEFAULT fallback
**Goal**: Команда с единой cascade-политикой по всей org может развернуть инстанс без `.github/auto-merge.yml` в каждом репо — zero-config установка.
**Depends on**: Phase 6 (env additions)
**Requirements**: DEF-01, DEF-02, DEF-03, DEF-04
**Success Criteria** (what must be TRUE):
  1. Репо без `.github/auto-merge.yml` (Contents API 404) при наличии `DEFAULT_CASCADE_CONFIG_FILE` или `DEFAULT_CASCADE_CONFIG_YAML` начинает каскадить через default-конфиг — без Check Run "config missing"
  2. При коллизии источников применяется precedence: repo > file > env; structured log пишет `config_source: repo | file_default | env_default` per-load
  3. Boot fail-fast если `DEFAULT_CASCADE_CONFIG_*` задан, но zod отвергает содержимое — не ждать первого webhook'а
  4. Файл `DEFAULT_CASCADE_CONFIG_FILE` перечитывается по mtime polling каждые 60s; правка ConfigMap в k8s применяется без restart pod'а
**Plans**: 4 plans
- [x] 07-01-PLAN.md — env.ts DEFAULT_CONFIG_RELOAD_MS + loader.ts ConfigSource type/Map/getter scaffolding
- [x] 07-02-PLAN.md — src/config/defaultLoader.ts module (boot fail-fast + hot-reload tick) + unit tests
- [x] 07-03-PLAN.md — loader.ts surgical edits at 2 hook sites + config_resolved logs + integration test
- [x] 07-04-PLAN.md — index.ts boot wiring + shutdown.ts stop wiring + end-to-end composition test

### Phase 8: App Manifest flow
**Goal**: Self-host инсталлятор за <5 минут устанавливает App через one-click manifest вместо ручного создания GitHub App + копирования credentials.
**Depends on**: Phase 6 (env: `SETUP_ENABLED`, `SETUP_PUBLIC_URL`)
**Requirements**: SETUP-01, SETUP-02, SETUP-03, SETUP-04, SETUP-05
**Success Criteria** (what must be TRUE):
  1. Открыв `/setup/new` (gated `SETUP_ENABLED=true`), оператор попадает на GitHub-страницу создания App с pre-filled permissions/events/webhook URL; в production-режиме endpoint не зарегистрирован вообще
  2. CSRF-атака отбивается: tampered `state` или отсутствующий cookie → 400 на `/setup/callback` (timingSafeEqual)
  3. Refresh браузера на success-странице не теряет credentials и не вызывает повторный `POST /app-manifests/{code}/conversions` — кред-ы записаны на диск до рендера HTML
  4. Success-страница не выводит сырой PEM/секреты в HTML; есть кнопка «Download .env» (Content-Disposition attachment) и redacted-tail для визуальной верификации
  5. Повторный запуск `/setup/new` при существующих credentials показывает warning + ссылку на recovery вместо тихого создания дублирующего App
**Plans**: 6 plans
- [ ] 08-01-PLAN.md — env.ts + log.ts + auth.ts foundations (SETUP_APP_NAME/SETUP_OUTPUT_DIR + redact paths + getAnonymousOctokit)
- [ ] 08-02-PLAN.md — src/setup helpers: html.ts (escapeHtml) + csrf.ts (cookie + timingSafeEqual) + manifestSchema.ts (buildManifest)
- [ ] 08-03-PLAN.md — src/setup/credentials.ts (atomic persist + TTL setTimeout.unref + checkStaleOnBoot)
- [ ] 08-04-PLAN.md — src/setup/manifestForm.ts (GET /setup/new + warning page + duplicate guard + state cookie)
- [ ] 08-05-PLAN.md — src/setup/manifestCallback.ts (CSRF → anonymous conversion → persist → success + cookie-gated download)
- [ ] 08-06-PLAN.md — src/setup/routes.ts + server.ts gate + index.ts boot stale-check + e2e integration test

### Phase 9: Onboarding webhook + PR-bot
**Goal**: Установка App на org/repo автоматически открывает draft-PR с конфигом и workflow'ом — команда видит готовую отправную точку, не копирует README в каждый репо вручную.
**Depends on**: Phase 6 (env additions)
**Requirements**: ONBOARD-01, ONBOARD-02, ONBOARD-03, ONBOARD-04, ONBOARD-05, ONBOARD-06, ONBOARD-07, ONBOARD-08
**Success Criteria** (what must be TRUE):
  1. После `installation.created` / `installation_repositories.added` для каждого выбранного репо появляется draft-PR `auto-merge/onboarding → default_branch` с `.github/auto-merge.yml` (template с реальным default branch, не hardcoded `main`) и `.github/workflows/auto-merge-dispatch.yml`
  2. Bulk-install 80 репо за один webhook → не более 2 параллельных репо в работе (p-limit), первые 20 синхронно + остаток через MultiQueue, 0 secondary-rate-limit (403), 0 onboarding Slack/Telegram сообщений
  3. Закрытие onboarding PR оператором без merge → повторный webhook на тот же репо НЕ создаёт второй PR (idempotency через `pulls.list state=all`)
  4. Репо с `*` branch protection → onboarding не пытается push через protection; вместо этого создаётся Issue с draft-содержимым и инструкцией (никаких force-push, никаких 422 в логе без сигнала оператору)
  5. `installation.deleted` → MultiQueue slot и disabledRepos LRU per-installation очищены; reinstall в пределах 24h TTL не наследует stale state
**Plans**: 10 plans
- [x] 09-01-PLAN.md — suppressionSet (TTL Map singleton for cascade-notify suppression during onboarding)
- [x] 09-02-PLAN.md — tokenRetry (3x backoff wrapper around getInstallationOctokit for token-mint race)
- [x] 09-03-PLAN.md — templates (buildYmlConfig + DISPATCH_WORKFLOW_YML + buildPrBody pure functions)
- [x] 09-04-PLAN.md — envNotify (Slack/Telegram env-level fallback bypassing repo config)
- [x] 09-05-PLAN.md — onboardRepo (9-step idempotent state machine per repo)
- [x] 09-06-PLAN.md — multiQueue.clearByInstallation (additive method for installation.deleted cleanup)
- [x] 09-07-PLAN.md — MultiChannel suppressionCheck option (additive ctor arg + queue_overflow key extraction)
- [x] 09-08-PLAN.md — onboarding handler (p-limit batch + fire-and-forget + aggregate summary + p-limit install)
- [x] 09-09-PLAN.md — wiring (webhook/handler signature + server.ts gate + index.ts boot)
- [x] 09-10-PLAN.md — integration test (SC1-SC5 end-to-end via msw + signed webhooks)

### Phase 10: Diagnose endpoint
**Goal**: Оператор за один HTTP-вызов получает полный health-snapshot конкретного репо: permissions, config source, branch existence, protection, notify status — без чтения логов или ручных API-проб.
**Depends on**: Phase 6 (healthCheck), Phase 7 (config source field), Phase 9 (template inspection for "missing" hints)
**Requirements**: DIAG-01, DIAG-02, DIAG-03, DIAG-04
**Success Criteria** (what must be TRUE):
  1. `GET /diagnose/{owner}/{repo}` с валидным bearer возвращает JSON со всеми полями: app_installed, app_permissions, config_loaded (с `source: repo | file_default | env_default`), branches_exist, branch_protection_status, notify_credentials_status; `Accept: text/markdown` отдаёт human-readable вывод
  2. Запрос без `Authorization: Bearer` / с неправильным токеном → 401 за константное время (timingSafeEqual); если `DIAGNOSE_TOKEN` env не задан — endpoint возвращает 503 (disabled)
  3. 11-й запрос с одного IP за 60s → 429 (in-memory TTL-LRU rate-limit)
  4. Response никогда не содержит full Slack webhook URL / Telegram bot token / private key: Slack URL отображается как `https://hooks.slack.com/services/.../****`, secrets — only `present/absent + byte length`
**Plans**: 5 plans
- [x] 10-01-PLAN.md — rate-limit + redaction primitives (src/diagnose/rateLimit.ts, redact.ts)
- [ ] 10-02-PLAN.md — parallel probes module (src/diagnose/probes.ts + types.ts) composing Phase 6/7
- [ ] 10-03-PLAN.md — markdown renderer (src/diagnose/markdown.ts) with snapshot tests
- [ ] 10-04-PLAN.md — handler + route registration + server.ts/index.ts wiring
- [ ] 10-05-PLAN.md — end-to-end integration test for DIAG-01..04 Success Criteria
**UI hint**: yes

### Phase 11: Release artifacts
**Goal**: Self-hoster ставит инстанс на VPS / k8s / PaaS за 10-15 минут — multi-arch image, Helm chart, готовые templates для Fly.io / Render / Compose+Caddy и rewritten README с тремя путями установки.
**Depends on**: Nothing (parallel-friendly to Phases 6-10; no `src/` dependency)
**Requirements**: REL-01, REL-02, REL-03, REL-04, REL-05, REL-06, REL-07, REL-08, REL-09
**Success Criteria** (what must be TRUE):
  1. `git tag v1.1.x && git push --tags` → GitHub Actions публикует `ghcr.io/<owner>/auto-merge:<semver>` / `:latest` / `:sha-<7>` multi-arch (amd64 + arm64) за <10 минут (matrix-per-arch, без QEMU)
  2. Каждый release-image имеет cosign keyless OIDC signature и SLSA build provenance attestation — `cosign verify ghcr.io/.../auto-merge:v1.1.0 --certificate-identity-regexp ...` проходит
  3. Helm chart в `deploy/helm/auto-merge/` устанавливается через `helm install ... --set existingSecretName=...` без секретов в `values.yaml`; `replicaCount > 1` → chart падает с `fail` (hard guard)
  4. Compose template (`examples/compose/docker-compose.yml` + Caddyfile) поднимает инстанс с auto-TLS на VPS; README имеет DNS-first checklist + `compose.staging.yml` overlay для Let's Encrypt staging endpoint
  5. Fly.io / Render templates деплоятся by-the-book; multi-line PRIVATE_KEY принимается и как raw PEM, и как base64 (env loader делает one-shot decode при `-----BEGIN`-маркере после base64-decode)
  6. README имеет три пути установки (Manifest+Compose+Caddy / Helm / PaaS), DNS-first warning, troubleshooting секцию и ссылки на `/diagnose`
**Plans**: TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v1.0 | 7/7 | Complete | 2026-05-20 |
| 2. Cascade Engine | v1.0 | 8/8 | Complete | 2026-05-21 |
| 3. Reliability & Operations | v1.0 | 7/7 | Complete | 2026-05-21 |
| 4. Notifications & Release | v1.0 | 5/5 | Complete | 2026-05-22 |
| 5. Address v1.0 tech debt | v1.0 | 5/5 | Complete | 2026-05-22 |
| 6. Foundation — env + notify healthCheck | v1.1 | 0/4 | Planned | - |
| 7. Config DEFAULT fallback | v1.1 | 4/4 | Complete   | 2026-05-23 |
| 8. App Manifest flow | v1.1 | 0/6 | Planned | - |
| 9. Onboarding webhook + PR-bot | v1.1 | 9/10 | In Progress|  |
| 10. Diagnose endpoint | v1.1 | 1/5 | In Progress|  |
| 11. Release artifacts | v1.1 | 0/0 | Not started | - |

---

*Roadmap created: 2026-05-20*
*Last updated: 2026-05-22 — v1.1 Onboarding & Bootstrap phases added (6-11)*
