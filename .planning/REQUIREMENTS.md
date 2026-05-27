# Requirements: auto-merge v1.1 Onboarding & Bootstrap

**Defined:** 2026-05-22
**Goal:** Сократить self-host установку с ~часа ручной работы до 10-15 минут — one-click App Manifest, auto-bootstrap репо, observability и production-ready release artifacts.

## v1.1 Requirements

### App Manifest Flow

- [ ] **SETUP-01**: Endpoint `GET /setup/new` отдаёт HTML с auto-submitting формой `POST https://github.com/settings/apps/new`, тело формы — pre-filled JSON manifest (permissions, events, webhook URL из `SETUP_PUBLIC_URL`, name). Inline TS template literal, без template engine
- [ ] **SETUP-02**: CSRF protection — `state` параметр в манифесте + httpOnly cookie с тем же значением; `/setup/callback` валидирует `state` через `crypto.timingSafeEqual` до обращения к GitHub API
- [ ] **SETUP-03**: Endpoint `GET /setup/callback?code=&state=` обменивает `code` на credentials через анонимный `POST /app-manifests/{code}/conversions` (`@octokit/request` без auth); credentials **persist на диск** (`SETUP_OUTPUT_DIR/credentials.env`) **до** рендера HTML, чтобы refresh браузера не терял ключ
- [ ] **SETUP-04**: Страница успеха показывает `APP_ID`, `WEBHOOK_SECRET`, redacted-tail `PRIVATE_KEY` (последние 4 символа), кнопку «Download .env» (Content-Disposition attachment) и инструкцию по установке env vars. Никакого server-side хранения после рендера (файл удаляется через 1h TTL)
- [ ] **SETUP-05**: Setup-routes gated через env `SETUP_ENABLED=true` (default `false`) — в production-режиме endpoints вообще не регистрируются в Fastify. Duplicate-setup guard: если `credentials.env` уже существует, `/setup/new` показывает warning + ссылку на recovery вместо повторного флоу

### Onboarding Webhook

- [x] **ONBOARD-01**: Подписка на webhook события `installation.created` (App установлен на org/user) и `installation_repositories.added` (репо добавлены в существующую установку); подписка через существующий `registerHandlers(probot, deps)` в `src/webhook/handler.ts`
- [x] **ONBOARD-02**: Per-repo state machine: (1) detect default branch через `GET /repos/{o}/{r}` (fallback `main` если поле пусто), (2) проверить existence `.github/auto-merge.yml` и `.github/workflows/auto-merge-dispatch.yml` через Contents API, (3) создать branch `auto-merge/onboarding` от default branch, (4) PUT оба файла, (5) открыть draft PR с checklist body
- [x] **ONBOARD-03**: Idempotency — пропустить репо если: оба файла уже существуют ИЛИ открытый PR `auto-merge/onboarding → default` уже есть ИЛИ закрытый-без-merge onboarding PR существует (не пересоздавать; logging only)
- [x] **ONBOARD-04**: Batched throughput control — `installation_repositories.added` payload может содержать N репо (всё установлено сразу = десятки/сотни); обрабатывать sequentially с `p-limit(2)`, cap 20 синхронно + остаток через MultiQueue с low-priority задержкой. Suppress cascade-conflict уведомления во время onboarding (флаг в context)
- [x] **ONBOARD-05**: PR body содержит: (a) объяснение что это, (b) checklist «проверить `release_branch`», «заполнить `slack_channel` / `telegram_chat_id`», «убедиться что target branches существуют», (c) ссылку на `/diagnose/{owner}/{repo}` для проверки настройки, (d) `@author`-mention installer (`installation.sender.login`) если доступен
- [x] **ONBOARD-06**: Branch protection awareness — если default branch имеет required reviews / push restrictions, onboarding не пытается push в protected; вместо push в `auto-merge/onboarding` создаёт Issue с draft содержимым yml/workflow и инструкцией. Никаких force-push, никаких попыток обойти protection
- [x] **ONBOARD-07**: `installation.created` token-mint retry — при минтинге installation token сразу после события возможна 401 race; retry с exponential backoff (3 попытки: 500ms / 1s / 2s) до перехода в degraded state
- [x] **ONBOARD-08**: `installation.deleted` event — очистить relevant in-memory state (`MultiQueue` per-installation slot, source-sha LRU partition если применимо) без попыток API-операций (App уже не имеет прав)

### Diagnostics & Health

- [x] **DIAG-01**: Endpoint `GET /diagnose/{owner}/{repo}` возвращает JSON с проверками: app_installed, app_permissions (актуальный set vs required), config_loaded (source: repo/file-default/env-default), branches_exist (`main_branch`, `release_branch`?, `dev_branch`), branch_protection_status, notify_credentials_status. Поддержка `Accept: text/markdown` для human-readable вывода
- [x] **DIAG-02**: Bearer-token auth — endpoint требует `Authorization: Bearer <DIAGNOSE_TOKEN>` (env), сравнение через `crypto.timingSafeEqual`; если `DIAGNOSE_TOKEN` не задан — endpoint возвращает 503 (disabled), не 200 с проверками
- [x] **DIAG-03**: Rate limit — 10 запросов в минуту на IP через in-memory TTL-LRU; 429 при превышении. Защита от probing/info-disclosure
- [x] **DIAG-04**: Output redaction — webhook URLs, bot tokens (если попадут в payload), private key — никогда не в response. Slack webhook URL отображается как `https://hooks.slack.com/services/.../****` (last 4 chars)
- [ ] **DIAG-05**: Boot-time notify health-check — функция `src/notify/healthCheck.ts` пробует Slack `auth.test` (если bot-token) ИЛИ HEAD на incoming webhook URL (reachability only), и Telegram `getMe`; результат кэшируется на 15 минут (используется в `/readyz` и `/diagnose`)
- [ ] **DIAG-06**: `/readyz` extension — возвращает 200 даже если notify health-check вернул error (warn-only default); JSON body содержит `notify_status: { slack: "ok|unreachable|misconfigured|n/a", telegram: "..." }`. Strict mode через env `NOTIFY_HEALTHCHECK_REQUIRED=true` → 503 при unreachable
- [ ] **DIAG-07**: Boot fail-fast distinguishes formatting vs connectivity — malformed token (regex mismatch для Slack URL / Telegram bot-token format) → fail-fast при boot через zod. Connectivity errors (timeout, 5xx, network) → degraded mode + warning log

### Release Artifacts

- [x] **REL-01**: GitHub Actions release workflow `.github/workflows/release.yml` — trigger на `push` тэгов `v*.*.*`, публикует multi-arch (amd64 + arm64) образ в `ghcr.io/<owner>/auto-merge:<semver>`, `:latest`, `:sha-<7>` через `docker/build-push-action@v7.2.0` + `docker/setup-buildx-action@v3` + `docker/setup-qemu-action@v3`
- [x] **REL-02**: Image attestations — `provenance: true` (SLSA build provenance) + `sbom: true` (SPDX SBOM) встроены в release.yml; cosign keyless OIDC signing через `sigstore/cosign-installer@v3` с `id-token: write` permission
- [x] **REL-03**: Helm chart в `deploy/helm/auto-merge/` — `Chart.yaml` (apiVersion v2), `values.yaml`, шаблоны: `deployment.yaml`, `service.yaml`, `ingress.yaml`, `serviceaccount.yaml`. **HARD GUARD:** `replicaCount: 1` с `fail` если оператор задаёт больше (in-memory cascade lock не поддерживает multi-replica)
- [x] **REL-04**: Helm secret management — `existingSecretName` reference вместо inline (no `PRIVATE_KEY` в `values.yaml`); поддержка external-secrets pattern через `envFrom.secretRef`; webhook secret / Slack URL / Telegram token — все через secret references
- [x] **REL-05**: Helm pod spec — `terminationGracePeriodSeconds: 60` (соответствует SHUTDOWN_TIMEOUT_MS), readinessProbe на `/readyz`, livenessProbe на `/healthz`, `runAsNonRoot: true`, `runAsUser: 1000` (matches Dockerfile)
- [x] **REL-06**: Docker Compose template в `examples/compose/docker-compose.yml` + `Caddyfile` — Caddy reverse-proxy с auto-TLS via Let's Encrypt. README с DNS-first checklist (поднять DNS A-record → подождать propagation → `docker compose up`); ship `compose.staging.yml` overlay с Let's Encrypt staging endpoint для testing
- [x] **REL-07**: Fly.io template в `examples/paas/fly/` — `fly.toml` с health checks, env vars (`PRIVATE_KEY` через `fly secrets set` с base64-encoded PEM), README с пошаговым deploy
- [x] **REL-08**: Render.com template в `examples/paas/render/` — `render.yaml` blueprint, env-секреты, README. PaaS-агностичный совет: поддержка `PRIVATE_KEY` как base64 (новые строки превращаются в `\n` через env) — добавить в env loader разовое base64-decode если строка начинается с `-----BEGIN`-маркером после decode
- [ ] **REL-09**: README rewrite — секция «Install» с тремя путями (One-click Manifest + Compose+Caddy / Helm / PaaS), DNS-first warning для Compose, troubleshooting секция, ссылки на `/diagnose`

### Org Default Config

- [ ] **DEF-01**: `DEFAULT_CASCADE_CONFIG_FILE` env var — путь к файлу `.yml` mounted в контейнер (k8s ConfigMap, Docker bind-mount); читается один раз на boot, валидируется через existing zod-schema, fail-fast при malformed
- [ ] **DEF-02**: `DEFAULT_CASCADE_CONFIG_YAML` env var — fallback для PaaS где монтировать файлы трудно; YAML inline в env (документировать multiline escaping); читается один раз на boot, валидируется через existing zod-schema
- [ ] **DEF-03**: Precedence — repo-level `.github/auto-merge.yml` > `DEFAULT_CASCADE_CONFIG_FILE` > `DEFAULT_CASCADE_CONFIG_YAML`. ConfigLoader (`src/config/loader.ts`) при 404 на Contents API не возвращает error, а делает fallback в порядке precedence. Logging: при использовании default-источника писать `config_source: file_default | env_default` в structured log
- [ ] **DEF-04**: Hot-reload — изменения `DEFAULT_CASCADE_CONFIG_FILE` через mtime polling каждые 60s (configurable через env); изменения требуют не restart, а просто переписать файл. `DEFAULT_CASCADE_CONFIG_YAML` — restart-only (env vars не меняются runtime)

## Future Requirements (v1.2+)

- **WIZARD-V12-01**: Full setup wizard (multi-step UI с manifest + sample-repo install + smoke-cascade)
- **DIAG-V12-01**: Dry-cascade — `/diagnose` ?dry=true показывает что бы влилось без real merge
- **REL-V12-01**: OCI-published Helm chart в GHCR (вместо chart-museum / GH Pages index)
- **NOTIFY-V12-01**: Vault / cloud KMS снippets для PRIVATE_KEY вместо env
- **CRON-V12-01**: `cron.suspend` config knob для maintenance windows

## Out of Scope (v1.1)

| Feature | Reason |
|---------|--------|
| **Auto-merge onboarding PR** | Нарушает auditability, требует согласия команды через ревью |
| **Server-side secret store** | Constraint: state только в GitHub; bot tokens в env инстанса |
| **Org-level config FILE в `.github` repo** | Re-introduces state-loading из стороннего репо (Renovate pattern); env-based достаточно |
| **Multi-replica Helm defaults** | In-memory cascade lock не поддерживает multi-instance; v2 |
| **Built-in HTTPS termination в App** | Caddy/Ingress/PaaS делают это лучше; не дублируем |
| **Per-installation runtime overrides** | Усложняет model; per-repo YAML + org default достаточно |
| **Web dashboard** | v2 thinking; GitHub-native UI + Slack/Telegram покрывают наблюдаемость |
| **Auto-create release branch** | Слишком инвазивно; команда сама управляет ветвлением |
| **Cosign keyed signing** | Keyless OIDC уже сильнее; ключи добавляют ops burden |
| **OAuth user-facing login** | Bearer-token для diagnose endpoint достаточно; нет user-facing UI |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SETUP-01 | Phase 8 | Pending |
| SETUP-02 | Phase 8 | Pending |
| SETUP-03 | Phase 8 | Pending |
| SETUP-04 | Phase 8 | Pending |
| SETUP-05 | Phase 8 | Pending |
| ONBOARD-01 | Phase 9 | Complete |
| ONBOARD-02 | Phase 9 | Complete |
| ONBOARD-03 | Phase 9 | Complete |
| ONBOARD-04 | Phase 9 | Complete |
| ONBOARD-05 | Phase 9 | Complete |
| ONBOARD-06 | Phase 9 | Complete |
| ONBOARD-07 | Phase 9 | Complete |
| ONBOARD-08 | Phase 9 | Complete |
| DIAG-01 | Phase 10 | Complete |
| DIAG-02 | Phase 10 | Complete |
| DIAG-03 | Phase 10 | Complete |
| DIAG-04 | Phase 10 | Complete |
| DIAG-05 | Phase 6 | Pending |
| DIAG-06 | Phase 6 | Pending |
| DIAG-07 | Phase 6 | Pending |
| REL-01 | Phase 11 | Complete |
| REL-02 | Phase 11 | Complete |
| REL-03 | Phase 11 | Complete |
| REL-04 | Phase 11 | Complete |
| REL-05 | Phase 11 | Complete |
| REL-06 | Phase 11 | Complete |
| REL-07 | Phase 11 | Complete |
| REL-08 | Phase 11 | Complete |
| REL-09 | Phase 11 | Pending |
| DEF-01 | Phase 7 | Pending |
| DEF-02 | Phase 7 | Pending |
| DEF-03 | Phase 7 | Pending |
| DEF-04 | Phase 7 | Pending |

**Coverage:**
- v1.1 requirements: 33 total
- Mapped to phases: 33 (100%)
- Unmapped: 0

---
*Requirements defined: 2026-05-22*
