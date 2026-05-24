# Phase 10: Diagnose endpoint - Context

**Gathered:** 2026-05-24
**Status:** Ready for planning

<domain>
## Phase Boundary

`GET /diagnose/{owner}/{repo}` — bearer-аутентифицированный endpoint, который за один HTTP-вызов отдаёт полный health-snapshot конкретного репо:

1. **app_installed** — установлен ли App на этом репо (через `apps.getRepoInstallation`)
2. **app_permissions** — фактический set vs required, с явным diff (missing[])
3. **config** — source (`repo` / `file_default` / `env_default`) + резолвнутые `main_branch` / `release_branch?` / `dev_branch`
4. **branches** — existence + branch_protection per каскадной ветке
5. **notify_credentials_status** — переиспользуем cached `healthChecker.getStatus()` (slack/telegram)
6. **onboarding hint** — `.github/auto-merge.yml` присутствует? open onboarding PR? (композиция с Phase 9)

Stateless, без побочных эффектов на GitHub (никаких write-вызовов). JSON + `Accept: text/markdown`. Защищён bearer + rate-limit + redaction.

Phase НЕ занимается: release-артефакты / GHCR image / Helm chart / README (Phase 11); recreate / запуск onboarding flow из diagnose (только показать hint); drift detection (diff template'а из `templates.ts` с реальным файлом — vNext); per-installation aggregate diagnose (per-repo only); cron-driven health monitoring (operator вызывает on-demand); никаких write-вызовов в GitHub.

</domain>

<decisions>
## Implementation Decisions

### Module layout & route registration
- **D-01:** Новый файл `src/diagnose/handler.ts` экспортирует `registerDiagnoseRoute(app: FastifyInstance, deps: DiagnoseDeps): void`, регистрируется из `src/server.ts` (за пределами SETUP_ENABLED-блока — это отдельный operator-tool, не setup flow). Активация — безусловная, но без `DIAGNOSE_TOKEN` endpoint всегда возвращает 503 (см. D-07). Pattern зеркалит `src/setup/routes.ts` + `src/setup/manifestForm.ts` split.
- **D-02:** Pure logic — отдельные функции в `src/diagnose/probes.ts` (Octokit-вызовы) + `src/diagnose/markdown.ts` (рендер). Handler в `handler.ts` — только Fastify-glue + composition. Зеркалит `webhook/pushHandler.ts` (glue) vs `cascade/orchestrator.ts` (pure logic) разделение.
- **D-03:** `DiagnoseDeps`: `{ env: Env, log: pino.Logger, octokitFactory: (installationId: number) => Promise<Octokit>, healthChecker: NotifyHealthChecker }`. `octokitFactory` — уже существующий `getInstallationOctokit` (FROZEN-safe использование, без модификации auth.ts). `healthChecker` — singleton из Phase 6 (D-07 wiring уже есть в `src/index.ts`).

### Probe set + concurrency (composes Phase 6/7/9)
- **D-04:** **Step 1 — installation resolve:** App-level Octokit (через `app.eachInstallation` или прямой `app.octokit` — planner выберет; вариант: kept singleton App-Octokit в `BuildServerDeps`, переиспользуем) вызывает `apps.getRepoInstallation({owner, repo})`. На 404 → отдать `{ app_installed: {status:'error', detail:'app-not-installed'} }` + skip всю downstream-композицию (остальные пробы возвращают `n/a`). На 200 → получаем `installation_id` для downstream.
- **D-05:** **Step 2 — parallel probes (Promise.allSettled, per-call timeout 3000ms через `AbortSignal.timeout`):**
  1. `apps.getInstallation({installation_id})` — `permissions` object + `events` array
  2. `loadConfig({octokit, owner, repo, log, notify: undefined})` — даёт `{config, errors, source}`. Передаём `notify: undefined`, чтобы не дёргать notify dispatcher на diagnose-пути (это побочка побочки). После результата читаем три ветки из `config` (`main_branch`/`release_branch?`/`dev_branch`).
  3. Для каждой резолвнутой ветки: `repos.getBranch({owner, repo, branch})` + `repos.getBranchProtection({owner, repo, branch})`. Второй вызов на 404 → `protected: false` (норма для незащищённых веток).
  4. `repos.getContent({owner, repo, path: '.github/auto-merge.yml', ref: <default_branch>})` — для onboarding hint `config_present`
  5. `pulls.list({owner, repo, state: 'open', head: '${owner}:auto-merge/onboarding'})` — для hint `open_pr`
- **D-06:** **Continue-on-error:** каждая проба ловит свою ошибку, маппится в `status: 'ok' | 'warn' | 'error' | 'n/a'` + `detail`. Падение одной не ломает остальные (SC1: «JSON со всеми полями»). Per-probe log на `WARN` для error-статусов с `event: diagnose_probe_failed, probe: <name>, owner, repo`. Никаких retry — operator может перевызвать endpoint.

### Pre-handler chain & rate-limit
- **D-07:** **Order — 503-gate → rate-limit → bearer-auth → handler.** Реализация: один `preHandler` hook в роуте, проверяющий по очереди:
  1. `if (!env.DIAGNOSE_TOKEN) return reply.code(503).send({ error: 'diagnose-disabled' })`. Не тратим rate-budget на disabled endpoint.
  2. Rate-limit (D-08).
  3. Bearer compare через `timingSafeEqual` с length-pad (на mismatch длин — padded compare против нулевого буфера, чтобы не leak'ить длину секрета). `Authorization: Bearer <token>` отсутствует / неправильный → 401 без body.
- **D-08:** **Rate-limit storage — собственный `LRUCache<string, { count: number, resetAt: number }>` в `src/diagnose/rateLimit.ts`:**
  - `new LRUCache({ max: 10_000, ttl: 60_000 })` — key = `req.ip`
  - Логика: get → если entry отсутствует ИЛИ `Date.now() >= entry.resetAt` → создать `{count: 1, resetAt: now+60_000}`; иначе если `entry.count >= 10` → 429 с `Retry-After: <seconds-until-reset>`; иначе increment.
  - **НЕ берём `@fastify/rate-limit`** — единственный endpoint с RL в проекте, лишний dep против стиля v1.0 («direct-impl вместо libs», как Slack/Telegram fetch).
  - `req.ip` — Fastify default берёт socket.remoteAddress; для production за reverse-proxy нужен `trustProxy: true` в Fastify config. **Planner добавляет `trustProxy: true` в `Fastify({...})` в `src/server.ts`** (безопасно — мы за Caddy/k8s ingress по README; v1.0 не использовал req.ip).
- **D-09:** **Constant-time auth compare implementation:**
  ```ts
  function compareBearer(received: string, expected: string): boolean {
    const recBuf = Buffer.from(received);
    const expBuf = Buffer.from(expected);
    if (recBuf.length !== expBuf.length) {
      // pad to expBuf length, compare to all-zero buffer of expBuf length — выполняет работу timingSafeEqual без leak длины
      crypto.timingSafeEqual(Buffer.alloc(expBuf.length), Buffer.alloc(expBuf.length));
      return false;
    }
    return crypto.timingSafeEqual(recBuf, expBuf);
  }
  ```
  Planner финализирует точную сигнатуру. Главное — на length-mismatch также выполнить dummy `timingSafeEqual`, чтобы wall-clock был константный.

### Response shape & content negotiation
- **D-10:** **JSON-схема (sectioned):**
  ```ts
  {
    ok: boolean,                 // false если есть хотя бы один error-status в checks
    owner: string,
    repo: string,
    checked_at: string,          // ISO 8601
    checks: {
      app_installed: { status, detail?, installation_id? },
      app_permissions: { status, actual: Record<string,string>, required: Record<string,string>, missing: string[] },
      config: { status, source?: 'repo'|'file_default'|'env_default', main_branch?, release_branch?, dev_branch?, errors?: string[] },
      branches: Record<string, { exists: boolean, protected: boolean, restrictions?: object }>,
      notify: { slack: NotifyStatus, telegram: NotifyStatus },
      onboarding: { config_present: boolean, open_pr?: { number, html_url } }
    }
  }
  ```
  `status: 'ok' | 'warn' | 'error' | 'n/a'`. `n/a` — когда проба не применима (e.g. notify.slack = `n/a` если `SLACK_WEBHOOK_URL` не задан). `warn` — частичное состояние (e.g. branch existion есть, protection не настроена — это choice operator'а, не ошибка). `error` — actual problem (app не установлен, permission missing, branch не существует).
- **D-11:** **HTTP status:** всегда 200 (даже при `ok: false`) — operator должен видеть детали без mid-tier-proxy интерпретации 5xx. Исключения: 401/429/503 (security gates) — body минимальный/отсутствует.
- **D-12:** **Markdown rendering:** pure-function `renderMarkdown(report: DiagnoseReport): string` в `src/diagnose/markdown.ts`, без библиотек. Структура: H1 заголовок (`# Diagnose: owner/repo`), per-section H2 + bullet-list. Эмодзи `✅/⚠️/❌/➖` для status. Snapshot-test через vitest `expect(rendered).toMatchSnapshot()`. Content-negotiation: parse `Accept` header через простую string-check (`accept.includes('text/markdown')`); default — JSON. Не тянем `@fastify/accepts`.

### Composition с Phase 7/9
- **D-13:** **config_source** — берём через свежий `loadConfig()` (D-05.2), не через `getRepoConfigSource()` (тот возвращает stale из кэша). Это даёт actual ground-truth и логирует `config_resolved` (Phase 7 D-10).
- **D-14:** **onboarding hints — fact-based, не template-diff:**
  - `config_present`: result `repos.getContent('.github/auto-merge.yml', ref=default_branch)` → 200 = true, 404 = false. Это более honest сигнал чем `loadConfig` (который при `file_default` ответит source != undefined даже если в репо файла нет).
  - `open_pr`: result `pulls.list(head=...:auto-merge/onboarding, state=open)` → first match.
  - **Композиционная логика:**
    - `config_present=true` → `onboarding.status='ok'`, hint: «config in repo»
    - `config_present=false` И `source='file_default'|'env_default'` → `onboarding.status='ok'`, hint: «using org-default»
    - `config_present=false` И `source=undefined` И `open_pr` найден → `onboarding.status='warn'`, hint: «onboarding PR #N waiting for review» + url
    - `config_present=false` И `source=undefined` И `open_pr=null` → `onboarding.status='error'`, hint: «no config and no onboarding PR — run /setup`
  - Template strings (`src/onboarding/templates.ts`) **НЕ** инспектируем. Drift detection — отдельная фаза vNext.

### Required permissions set
- **D-15:** Required permissions zashardcoded в `src/diagnose/handler.ts` (constant):
  ```ts
  const REQUIRED_PERMISSIONS = {
    contents: 'write',
    pull_requests: 'write',
    checks: 'write',
    metadata: 'read',
  };
  ```
  Это фиксированный set из PROJECT.md «Constraints / Permissions». При добавлении новых API-вызовов permissions расширяется здесь же. Diff: для каждой required key проверяем, что в `actual[key]` есть нужный уровень (write > read). `missing` = required keys без `actual` ИЛИ с downgrade'нутым уровнем.

### Redaction (DIAG-04)
- **D-16:** Redaction в момент сборки response, не через pino redact (это для логов). Утилита `src/diagnose/redact.ts` экспортирует:
  - `redactSlackUrl(url: string | undefined): string | null` → если undefined → null; иначе `url.slice(0, url.lastIndexOf('/') + 1) + '****'`
  - `redactSecret(value: string | undefined): { present: boolean, byte_length: number }` → используется для `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`, `PRIVATE_KEY` если такие поля попадают в response (через notify_credentials_status секцию).
- **D-17:** **В response не выводим сами credentials** — только sanitized хелперы. Notify section полагается на `healthChecker.getStatus()`, который возвращает enum (`ok|unreachable|misconfigured|n/a|pending`), а не raw URLs/tokens — естественная защита от leak'а.

### Wiring (D-01 + boot)
- **D-18:** `src/server.ts`: добавить `healthChecker: NotifyHealthChecker` в `BuildServerDeps`; **mandatory** (не optional) — diagnose route регистрируется всегда (даже без token — отдаёт 503). После существующего health-routes блока вызвать `registerDiagnoseRoute(app, { env, log, octokitFactory: deps.getInstallationOctokit, healthChecker: deps.healthChecker })`. Нужно также прокинуть `octokitFactory` в deps (extract из текущего `src/index.ts` wiring).
- **D-19:** `src/index.ts`: уже создаёт healthChecker (Phase 6 D-07) — добавить его в `buildServer({...deps, healthChecker, getInstallationOctokit})`. App-level Octokit для `apps.getRepoInstallation` (D-04) — либо использовать `probot.octokit` (App-JWT auth), либо minted-on-demand. Planner выберет на основе того, что Probot экспонирует чище.
- **D-20:** `src/server.ts` Fastify constructor: добавить `trustProxy: true` (см. D-08 про req.ip за reverse proxy). Безопасное расширение — v1.0 не использовал req.ip, поэтому regressions нет.

### Claude's Discretion
- Точная сигнатура `compareBearer` (D-09): inline helper vs отдельный экспорт; planner выберет на основе testability.
- Decoding ordering: parse Accept до или после auth/rate-limit. По соображениям симметрии — после, чтобы neотказ всегда был самым ранним сигналом.
- Точный shape `app_permissions.missing` (массив строк vs объект `{key, required, actual}`) — planner выберет читаемость.
- Per-channel notify detail в JSON (только status enum vs detail-объект с `last_checked_at`) — расширим если operator-feedback потребует.
- Markdown details (emoji-set, заголовки) — финализирует planner на snapshot.
- App-level Octokit access pattern для `apps.getRepoInstallation` (D-04) — точно один из: `probot.octokit` / `app.octokit` / minted-on-demand через `@octokit/auth-app`.
- Test fixtures для msw — по аналогии с onboarding tests (`test/integration/*-install.test.ts`).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope
- `.planning/ROADMAP.md` §"Phase 10: Diagnose endpoint" — goal, depends-on (Phase 6/7/9), success criteria 1-4.
- `.planning/REQUIREMENTS.md` DIAG-01 / DIAG-02 / DIAG-03 / DIAG-04 — feature definitions (JSON+markdown / bearer+503 / rate-limit / redaction).
- `.planning/PROJECT.md` §"Constraints" — `Permissions (GitHub App)` minimal set: `contents:write`, `pull_requests:write`, `checks:write`, `metadata:read`. Это источник `REQUIRED_PERMISSIONS` константы (D-15).

### Architecture & pitfalls
- `.planning/research/ARCHITECTURE.md` §"Component Responsibilities" — `src/diagnose/handler.ts` (NEW): «permissions probe + config load + branch existence + protection summary + notify ping; JSON response». §"Project Structure (v1.1 delta)" — `src/diagnose/` folder.
- `.planning/research/PITFALLS.md` Pitfall 9 (unauthenticated diagnose endpoint — bearer-auth, rate-limit, timingSafeEqual, redaction) + Pitfall 10 (don't probe Slack/Telegram per-request — reuse 15-min cache) + Pitfall 11 (degraded mode для notify не блокирует merge engine).

### Prior phase decisions (composition)
- `.planning/phases/06-foundation-env-notify-healthcheck/06-CONTEXT.md` D-05/D-06/D-07 — `NotifyHealthChecker.getStatus()` API + cache semantics; `NotifyStatus` enum.
- `.planning/phases/06-foundation-env-notify-healthcheck/06-CONTEXT.md` D-04 — `DIAGNOSE_TOKEN` env var (already staged).
- `.planning/phases/07-config-default-fallback/07-CONTEXT.md` D-08/D-10 — `loadConfig` return type `{config, errors, source}`, `getRepoConfigSource(owner, repo)` getter, `config_resolved` log event.
- `.planning/phases/09-onboarding-webhook-pr-bot/09-CONTEXT.md` D-13/D-26 — fixed branch name `auto-merge/onboarding`, template file path `.github/auto-merge.yml` (canonical config location, NOT `cascade:` wrapper).

### v1.0 patterns to follow
- `src/server.ts` — Fastify route registration pattern, conditional deps gating, `reply.code(...).send(...)` style.
- `src/setup/routes.ts` + `src/setup/manifestForm.ts` — `register*Route(app, deps)` split between aggregator and per-route file.
- `src/notify/healthCheck.ts` D-01 — `AbortSignal.timeout(timeoutMs)` для per-call timeout (D-05); fetch error → status enum mapping.
- `src/webhook/dedup.ts` / `src/cascade/sourceShaDedup.ts` — `LRUCache` usage style (для rate-limit D-08).
- `src/config/loader.ts` — `loadConfig()` signature и return shape (D-05.2 callsite).
- `src/auth.ts:getInstallationOctokit` — installation-scoped Octokit factory (FROZEN-safe).
- `src/env.ts` — `DIAGNOSE_TOKEN: z.string().min(16).optional()` (D-07 503-gate).

### Octokit / Probot API surface
- `octokit.rest.apps.getRepoInstallation({owner, repo})` — installation lookup, 404 если App не на репо (D-04).
- `octokit.rest.apps.getInstallation({installation_id})` — даёт `permissions` + `events` (D-05.1).
- `octokit.rest.repos.getBranch` / `getBranchProtection` — D-05.3 (404 на protection = unprotected, норма).
- `octokit.rest.repos.getContent` — D-05.4 / D-14 (`config_present` check).
- `octokit.rest.pulls.list` — D-05.5 / D-14 (`open_pr` lookup).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/notify/healthCheck.ts:createNotifyHealthChecker` — singleton instance уже создаётся в `src/index.ts` (Phase 6); пробрасываем в `BuildServerDeps.healthChecker` и читаем `.getStatus()` в diagnose handler. Cache 15 минут — никаких per-request пробок Slack/Telegram (Pitfall 10).
- `src/config/loader.ts:loadConfig` — возвращает `{config, errors, source}`; передаём `notify: undefined`, чтобы не триггерить notify dispatcher на diagnose-пути.
- `src/auth.ts:getInstallationOctokit` — installation-scoped Octokit для всех repo-level пробов (getBranch / getBranchProtection / getContent / pulls.list).
- `lru-cache` уже в deps (5 callsites: webhook/dedup, cascade/sourceShaDedup, config/loader, notify/slack ×2). Используем для rate-limit (D-08) — нулевая новая зависимость.

### Established Patterns
- **Conditional deps gating в server.ts:** lines 67-105 — pattern `if (deps.probot && deps.dedup && ...)`. Diagnose route активируется **всегда** (не gated), но возвращает 503 при `!env.DIAGNOSE_TOKEN`. Это даёт operator'у consistent UX: endpoint всегда на месте, его состояние — 503 vs 200.
- **`registerXxxRoute(app, deps)` пре-handler split** (`src/setup/manifestForm.ts`, `src/setup/manifestCallback.ts`): мы добавим `src/diagnose/handler.ts` в этом же стиле, агрегатор не нужен (одна route).
- **`AbortSignal.timeout(ms)` для I/O проб** — `src/notify/healthCheck.ts:probeSlack/probeTelegram`. Применим тот же паттерн в `src/diagnose/probes.ts`.
- **`crypto.timingSafeEqual` для secret compare** уже используется в `@octokit/webhooks` (через Probot для HMAC) — наш паттерн D-09 это формализует для bearer.
- **LRU TTL-cache idiom** — `src/cascade/sourceShaDedup.ts:5-8` (max 5000, TTL 24h, TTLAutopurge). Зеркалим: `max: 10_000, ttl: 60_000`.

### Integration Points
- `src/server.ts:39-68` — после health-routes блока добавить `registerDiagnoseRoute(app, deps)`. Перед или после webhook-блока — не имеет значения (нет shared state).
- `src/index.ts` (boot wiring) — `healthChecker` уже создаётся для Phase 6 D-07; добавить в `buildServer` deps + прокинуть App-level Octokit factory.
- FROZEN-инварианты: НЕ модифицируем `src/cascade/`, `src/webhook/multiQueue.ts`, `src/notify/dispatcher.ts`, `src/cron/safetyNet.ts`, `src/shutdown.ts`, `src/config/schema.ts`. Diagnose — pure-read композиция existing APIs.

</code_context>

<specifics>
## Specific Ideas

- Markdown header layout: `# Diagnose: {owner}/{repo}` + ISO timestamp; per-section H2; bullet-list с emoji ✅/⚠️/❌/➖. Snapshot-tested.
- Required-permissions hardcode (D-15) — должен соответствовать PROJECT.md «Constraints»; при будущем расширении API surface правится в одном месте.
- 401 без body, 429 с `Retry-After: <seconds>`, 503 с минимальным `{error: 'diagnose-disabled'}`. 200 даже при `ok: false`.

</specifics>

<deferred>
## Deferred Ideas

- **Drift detection** — diff содержимого `.github/auto-merge.yml` в репо с актуальным template'ом из `src/onboarding/templates.ts`. Полезно когда v1.2+ template эволюционирует. Отдельная фаза vNext.
- **Per-installation aggregate diagnose** (`GET /diagnose/installations/{id}`) — bulk-snapshot всех репо для одной установки. Удобно для operator'а после bulk-install. vNext.
- **Cron-driven health monitoring** — periodic auto-diagnose всех known репо + push в Slack/Telegram на ошибки. Out of scope v1.1.
- **Force-refresh notify cache** через `/diagnose?refresh=notify` — на текущем 15-минутном TTL не нужен; добавим если operator-feedback потребует.
- **`@fastify/accepts` для proper content-negotiation** (multi-format, q-values) — overkill для двух форматов; добавим если появится третий.
- **OpenAPI schema export** для diagnose response — полезно для downstream tooling. vNext если станет популярным endpoint'ом.

</deferred>

---

*Phase: 10-Diagnose endpoint*
*Context gathered: 2026-05-24*
