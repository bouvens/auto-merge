# Phase 9: Onboarding webhook + PR-bot — Context

**Gathered:** 2026-05-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Установка App на org/repo автоматически открывает draft-PR с `.github/auto-merge.yml` + `.github/workflows/auto-merge-dispatch.yml` в каждом выбранном репо. Stateless (источник истины — GitHub), идемпотентно, переживает bulk-install 80 репо без secondary-rate-limit, не пытается обойти branch protection.

Phase НЕ занимается: `/diagnose` (Phase 10); release-артефакты / README (Phase 11); onboarding для уже установленных App до v1.1 (out of scope — оператор может удалить-переустановить); auto-update workflow/config файла в репо после v1.1 (только initial bootstrap); detection release-branch / staging / qa (фиксированный template `main → dev`, оператор редактирует PR).

</domain>

<decisions>
## Implementation Decisions

### Webhook subscribers (ONBOARD-01)
- **D-01:** Расширить `src/webhook/handler.ts`: `registerHandlers(probot)` → `registerHandlers(probot, deps)` с добавлением `onboarding` в `deps`. Существующий log-call остаётся, после него делегат `onboarding.onInstallation(ctx)` / `onboarding.onRepositoriesAdded(ctx)` / `onboarding.onInstallationDeleted(ctx)`. Один subscriber per event, без распыления по файлам.
- **D-02:** События подписки: `installation.created` (initial install), `installation_repositories.added` (репо добавлены в существующую установку), `installation.deleted` (cleanup, см. D-15). `installation.suspend` / `installation_repositories.removed` игнорируем (ничего не откатываем — не удаляем чужой PR).

### Throughput control (SC2, ONBOARD-04, Pitfall-4)
- **D-03:** Standalone semaphore через `p-limit(2)` внутри `src/onboarding/handler.ts` на весь batch репо из payload. **Cap 20 sync убран** — все репо обрабатываются в одном flow, не делим на «sync + queue». Bulk install 80 репо последовательно по 2 параллельно ≈ 2-3 минуты wall-clock в worker process.
- **D-04:** Handler возвращает Promise сразу после кика batch'а (не `await` весь batch перед resolve), чтобы Probot ACK'нул webhook в пределах 10s timeout. Batch выполняется fire-and-forget в process, ошибки катятся в WARN log. Это не нарушает at-least-once семантику GitHub: повторная delivery того же event'а идёт через `src/webhook/dedup.ts`, идемпотентность on file/PR side покрывает остаток.
- **D-05:** **MultiQueue не используется для onboarding.** Реинтерпретируем SC2: «p-limit(2), webhook handler async-обрабатывает все репо последовательно (2 параллельно)». См. <sc_reinterpretations>.
- **D-06:** Cap на размер batch'а — нет (не ограничиваем по числу репо). Защита от cascade-в-cascade на bulk install — через D-12 (idempotency на file existence) + D-08 (notify suppression).

### Onboarding sequence per repo (ONBOARD-02)
- **D-07:** Sequence (для каждого репо в batch'е, под p-limit семафором):
  1. Получить installation Octokit через существующий `getInstallationOctokit(installationId)` из `src/auth.ts`.
  2. Resolve default_branch: payload `repository.default_branch` если есть; иначе `GET /repos/{o}/{r}` → `data.default_branch`; fallback `main` если пусто.
  3. **Idempotency check A**: `GET /repos/{o}/{r}/contents/.github/auto-merge.yml?ref={default_branch}`. 200 → log `onboard_skipped_config_exists` + return.
  4. **Idempotency check B**: `GET /repos/{o}/{r}/pulls?head={owner}:auto-merge/onboarding&state=all&per_page=20`. Если найден open onboarding PR → log `onboard_skipped_pr_open` + return. Если найден closed-no-merge onboarding PR → log `onboard_skipped_pr_declined` + return (ONBOARD-03: respect operator decision).
  5. Get default_branch sha: `GET /repos/{o}/{r}/git/ref/heads/{default_branch}` → `object.sha`.
  6. Create branch: `POST /git/refs` `{ref: refs/heads/auto-merge/onboarding, sha}`. **422 ("Reference already exists") → reactive branch-protection branch** (см. D-09) ИЛИ partial-prior-run — GET существующую ветку и продолжить.
  7. PUT `.github/auto-merge.yml` (template из `src/onboarding/templates.ts`, default_branch injected). **422 (file exists на ветке)** → GET blob sha → re-PUT с `sha` (идемпотентный overwrite).
  8. PUT `.github/workflows/auto-merge-dispatch.yml` (тот же pattern).
  9. Create draft PR: `POST /pulls` `{title: "auto-merge: bootstrap configuration", head: auto-merge/onboarding, base: default_branch, draft: true, body: <onboarding-doc>}`. **422 ("PR already exists")** → fetch existing → return id (idempotent).
- **D-08:** На любой 403 (permission missing) — log `onboard_failed_permission` + return (не retry, не notify через repo-config — её ещё нет).

### Branch protection fallback (SC4 переформулирован)
- **D-09:** **Reactive детект**: пытаемся git.createRef + PUT files; на 422/403 с конкретным protection-related сообщением — конвертируем в notify-fallback. Pre-flight `getBranchProtection` НЕ вызываем (лишний API call на каждый репо при bulk install).
- **D-10:** **Issue НЕ создаём.** Вместо этого: notify через global env-level каналы (`SLACK_WEBHOOK_URL` / `TELEGRAM_BOT_TOKEN` из env, **обходя repo-config**) с сообщением «Cannot create onboarding PR in `{owner}/{repo}` — branch protection blocks bot. Add files manually: <link to template gist or README section>». Параллельно `log.warn({event: onboard_protection_blocked, owner, repo, installation_id})`.
- **D-11:** Mechanism для «notify через global env, обходя config»: новый метод `MultiChannel.notifyEnvLevel(message)` или прямой вызов `SlackChannel`/`TelegramChannel` с фиктивным config={notifications:{slack:env.SLACK_WEBHOOK_URL}}. Planner финализирует precise API surface — главное чтобы это был additive add к notify-модулям без правки существующих методов.

### Idempotency (ONBOARD-03)
- **D-12:** Idempotency keys (по убыванию строгости):
  1. Existence `.github/auto-merge.yml` at default_branch HEAD (D-07.3) — финальное состояние, абсолютный skip.
  2. Open `auto-merge/onboarding` PR (D-07.4) — flight уже идёт, skip.
  3. Closed-no-merge `auto-merge/onboarding` PR (D-07.4) — оператор отказался, skip. **Не реоткрываем.**
- **D-13:** Branch naming **fixed `auto-merge/onboarding`** (per ONBOARD-02). Не используем suffix `-YYYYMMDD-<sha>` из Pitfall-6, потому что ONBOARD-03 + closed-no-merge skip уже покрывают «не nag оператора повторно». Force-push никогда (D-07.6/7 идут через GET sha → re-PUT).
- **D-14:** `dedup` LRU `src/webhook/dedup.ts` уже защищает от at-least-once delivery дублей по `delivery_id` — re-delivery того же webhook не запустит onboarding повторно в пределах TTL.

### installation.deleted cleanup (SC5 переформулирован)
- **D-15:** Additive метод `MultiQueue.clearByInstallation(installation_id: number): number` на `src/webhook/multiQueue.ts` — итерирует `lanes` Map, удаляет lanes с префиксом ключа `${installation_id}/`, возвращает кол-во удалённых lanes. **Additive** — не меняет существующих `enqueue`/worker/overflow paths, FROZEN-инвариант сохранён (только добавление публичного метода).
- **D-16:** disabledRepos LRU в `src/notify/slack.ts:59` / `src/notify/telegram.ts:81` keyed by `owner/repo` slug (без installation_id) — «per-installation cleanup» физически невозможен без re-key. **Не чистим, полагаемся на natural TTL (24h LRU TTLAutopurge).** То же для `sourceShaDedup` (key `owner/repo@sha`).
- **D-17:** `installation.deleted` handler: (1) extract `payload.installation.id`, (2) `multiQueue.clearByInstallation(id)`, (3) `log.info({event: onboard_installation_cleaned, installation_id, lanes_dropped})`. Никаких API-вызовов (App уже без прав — ONBOARD-08).

### Notify suppression во время onboarding (ONBOARD-04)
- **D-18:** `src/onboarding/suppressionSet.ts` — singleton state: `Map<installation_id, expiresAt>`, TTL 10 минут на запись. API: `markOnboarding(installation_id)` (set TTL=Date.now()+600_000), `isOnboarding(installation_id): boolean` (check TTL, auto-purge expired при чтении). TTL-purge ленивый при `isOnboarding` — не нужен `setInterval`.
- **D-19:** Integration через DI: `MultiChannel` конструктор принимает опциональный `suppressionCheck?: (installation_id: number) => boolean`. В `MultiChannel.notify()` если `suppressionCheck?.(payload.installation_id) === true` → return без notify. `installation_id` уже есть в cascade `notify.notify({installation_id, owner, repo, ...})` payload (см. orchestrator.ts:202+). Additive — существующие call sites не меняются если callback не передан.
- **D-20:** Wiring в `src/index.ts`: создаём `suppressionSet` singleton, передаём `suppressionSet.isOnboarding.bind(suppressionSet)` в `new MultiChannel(channels, { suppressionCheck })`. Onboarding handler вызывает `suppressionSet.markOnboarding(installation_id)` в начале batch'а (D-03).
- **D-21:** Suppression scope — **только cascade-conflict / cascade-failure notifications**. `queue_overflow` (multiQueue.ts:77) тоже скипается под suppression, потому что bulk install + случайный push в parent может временно переполнить очередь — это часть onboarding noise. Onboarding-success / onboarding-failure messages (D-10) идут через **отдельный path** (env-level notify, обходя MultiChannel.notify), на них suppression не действует.

### Token-mint retry (ONBOARD-07)
- **D-22:** При `installation.created` token mint через `getInstallationOctokit(id)` обёрнут в retry-helper: 3 попытки с backoff 500ms / 1s / 2s (per REQUIREMENTS). На 401/404 — retry; на любые другие коды — fail-fast. После 3 неудач — `log.error({event: onboard_token_mint_failed, installation_id})` + return (без notify; на этом этапе нет куда нотифицировать кроме global env-level, но это retry-race, не permanent failure).
- **D-23:** Retry-helper — отдельная функция в `src/onboarding/tokenRetry.ts`, не модифицирует `src/auth.ts:getInstallationOctokit` (FROZEN-инвариант).

### PR body content (ONBOARD-05)
- **D-24:** PR body template (статический Markdown с подстановками):
  - **Что это:** один параграф объяснения цели App'а.
  - **Checklist (чекбоксы):** «проверить `release_branch` если есть промежуточная ветка»; «заполнить `notifications.slack` / `notifications.telegram` chat_id»; «убедиться что `source`/`release_branch`/`dev_branch` все существуют в репо».
  - **Diagnose link:** `https://{SETUP_PUBLIC_URL}/diagnose/{owner}/{repo}` (даже если Phase 10 ещё не задеплоен — операт скопирует URL).
  - **Mention:** `@{installation.sender.login}` (если есть в payload) — installer получит notification GitHub'а.
- **D-25:** Template в `src/onboarding/templates.ts` как pure-function `buildPrBody({owner, repo, defaultBranch, senderLogin?, publicUrl}): string`. Unit-тестируется на snapshot.

### Workflow + config templates (ONBOARD-02)
- **D-26:** `.github/auto-merge.yml` template (минимальный валидный config). **CORRIGENDUM 2026-05-24:** ранее в D-26 ошибочно приводился формат `cascade: { source: ... }` — реальная `ConfigSchema` (`src/config/schema.ts:20-27`) определена плоско, без обёртки `cascade:` и с полем `main_branch` (не `source`). Канонический template (проходит `ConfigSchema.parse`):
  ```yaml
  main_branch: {{default_branch}}
  # release_branch: release  # uncomment if you have a staging/release branch between source and dev
  dev_branch: dev
  ```
  Schema-валидный (проверяется `src/config/schema.ts`), commented-out hint для release_branch.
- **D-27:** `.github/workflows/auto-merge-dispatch.yml` — копия v1.0 README example (workflow_dispatch trigger, env `APP_URL`). Хранится как string-литерал в `templates.ts`, без template substitution (нет per-repo вариаций).

### Wiring (D-01 + boot)
- **D-28:** `src/server.ts`: добавить `onboarding` в `BuildServerDeps`, прокидывать в `registerHandlers(deps.probot, { onboarding: deps.onboarding })`. Условие активации onboarding — то же `if (deps.probot && deps.dedup && deps.queue && deps.notify)` gate (line 67); onboarding mandatory когда вебхук-handlers зарегистрированы.
- **D-29:** `src/index.ts`: построить `onboarding` объект (`{onInstallation, onRepositoriesAdded, onInstallationDeleted}` методы) с inject'ом `{octokitFactory: getInstallationOctokit, multiQueue, suppressionSet, notifyEnvLevel, env}`. Передать в `buildServer({...deps, onboarding})`.

### Claude's Discretion
- Точная сигнатура `MultiChannel` конструктора (D-19) — `{ suppressionCheck?: ... }` options-object или positional 2nd arg.
- Точные log event names (`onboard_*` prefix consistent).
- Структура backoff helper'а в `tokenRetry.ts` — promisified setTimeout или библиотека.
- Тексты PR body параграфов (D-24) — planner финализирует на основе template.
- Concrete API shape `notifyEnvLevel` (D-11) — отдельный метод vs прямой `SlackChannel.send(env.SLACK_WEBHOOK_URL, msg)`.
- Сетка тестов: msw для GitHub API (создание branch/PR/contents), fake timers для retry/TTL, integration test full bulk-install flow через mock Probot context.

</decisions>

<sc_reinterpretations>
## ROADMAP Success Criteria — Reinterpretations

Discussion разрешила противоречия между ROADMAP SC и ARCHITECTURE research. Verifier / plan-checker должны использовать **переформулированные SC** ниже, не исходные:

### SC2 (throughput) — **MODIFIED**
- **Original:** «не более 2 параллельных репо в работе (p-limit), первые 20 синхронно + остаток через MultiQueue»
- **Reinterpreted:** «p-limit(2) на весь batch внутри одного webhook handler async-flow; webhook ACK к GitHub возвращается до завершения batch'а (fire-and-forget); MultiQueue для onboarding НЕ используется (FROZEN-инвариант)»
- **Reason:** MultiQueue в v1.0 FROZEN, Job-тип специфичен для cascade с notify-on-failure; mixing onboarding-task требует правки FROZEN компонента. ARCHITECTURE Q2 явно запрещает «Do NOT enqueue onboarding into MultiQueue». Cap 20 sync избыточен — p-limit(2) на 80 репо = 2-3 минуты, приемлемо.

### SC4 (branch protection) — **MODIFIED**
- **Original:** «вместо этого создаётся Issue с draft-содержимым и инструкцией»
- **Reinterpreted:** «вместо этого notify через global env-level Slack/Telegram (обходя repo-config) с инструкцией; параллельно WARN log `onboard_protection_blocked`; Issue не создаётся»
- **Reason:** Operator-решение — никаких Issue. Repo-config notifications на момент onboarding ещё не настроены, поэтому нужен env-level fallback path.

### SC5 (installation.deleted cleanup) — **MODIFIED**
- **Original:** «MultiQueue slot и disabledRepos LRU per-installation очищены»
- **Reinterpreted:** «MultiQueue lanes c префиксом `${installation_id}/` очищены через additive `clearByInstallation(id)`; disabledRepos LRU и sourceShaDedup LRU не чистятся per-installation (их ключи не содержат installation_id; полагаемся на natural TTL 24h)»
- **Reason:** Физическая невозможность per-installation cleanup для LRU без re-key (= правка FROZEN notify-модулей). TTL 24h ограничивает memory rest без дополнительной логики.

### SC1, SC3 — без изменений (locked as-is).

</sc_reinterpretations>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope
- `.planning/ROADMAP.md` §«Phase 9: Onboarding webhook + PR-bot» — goal, depends-on (Phase 6 env), 5 success criteria (с reinterpretations выше).
- `.planning/REQUIREMENTS.md` ONBOARD-01..08 — feature definitions.

### Architecture & pitfalls
- `.planning/research/ARCHITECTURE.md` §Q2 (webhook subscriber wiring), §Q6 (onboarding-PR sequence), §Q7 (idempotency без DB), §Q8 (NEW/MODIFIED files), §Q9 (build order). **Внимание:** SC2/SC4/SC5 переформулированы — следовать <sc_reinterpretations> в CONTEXT, не дословному тексту ARCHITECTURE.
- `.planning/research/PITFALLS.md` Pitfall-4 (bulk install spam), Pitfall-5 (token-mint race), Pitfall-6 (idempotency / closed-no-merge), Pitfall-7 (branch protection — operator выбрал notify-fallback вместо Check Run/Issue), Pitfall-8 (default-branch detection).

### Prior phases / context
- `.planning/phases/06-foundation-env-notify-healthcheck/06-CONTEXT.md` — env vars `SETUP_PUBLIC_URL`, notify health-check pattern. SETUP_PUBLIC_URL уже доступен из env для PR body /diagnose link.
- `.planning/phases/07-config-default-fallback/07-CONTEXT.md` — `tryLoadDefaultConfig` pattern в loader.ts (Phase 9 не модифицирует loader.ts, но template `.github/auto-merge.yml` должен быть schema-valid тем же `src/config/schema.ts`).
- `.planning/phases/08-app-manifest-flow/08-CONTEXT.md` — `getAnonymousOctokit` уже добавлен в `src/auth.ts` (мы используем `getInstallationOctokit` уже существующий, anonymous не нужен).

### v1.0 patterns to follow
- `src/webhook/handler.ts:5-23` — текущий `registerHandlers(probot)`, расширяем до `(probot, deps)` additive (D-01).
- `src/webhook/multiQueue.ts:32, 82, 145` — `lanes: Map<string, Lane<T>>`, `buildKey({installation_id, owner, repo})`. Добавляем additive метод `clearByInstallation(id)` (D-15).
- `src/notify/dispatcher.ts:3` — `MultiChannel implements NotificationChannel`. Расширяем конструктор additive options `{suppressionCheck?: ...}` (D-19).
- `src/notify/slack.ts:59, 95-97`, `src/notify/telegram.ts:81, 125-127` — disabledRepos LRU keyed by `owner/repo` slug, не трогаем (D-16).
- `src/auth.ts:108` — `getInstallationOctokit(installationId)` уже есть, используем в onboarding sequence (D-07).
- `src/cascade/orchestrator.ts:202, 256, 297` — call sites `notify.notify({installation_id, owner, repo, ...})` — `installation_id` уже в payload (требуется для suppression D-19).
- `src/server.ts:67` — conditional `if (deps.probot && deps.dedup && deps.queue && deps.notify)` gate — onboarding registers в этой же ветке (D-28).
- `src/log.ts` — pino redact pattern, новые `onboard_*` log events без новой инфры.

### GitHub REST endpoints (Octokit)
- `GET /repos/{o}/{r}` — default branch resolution (D-07.2).
- `GET /repos/{o}/{r}/contents/{path}?ref=` — idempotency check A (D-07.3).
- `GET /repos/{o}/{r}/pulls?head=X:branch&state=all` — idempotency check B, state=all (D-07.4).
- `GET /repos/{o}/{r}/git/ref/heads/{branch}` — sha for default branch (D-07.5).
- `POST /repos/{o}/{r}/git/refs` — create branch (D-07.6).
- `PUT /repos/{o}/{r}/contents/{path}` — write files (D-07.7/8).
- `POST /repos/{o}/{r}/pulls` — create draft PR (D-07.9).
- All scoped through installation token (existing `getInstallationOctokit`).

### Prior decisions still in force
- v1.0 — никакого Redis/DB, in-memory state only. Phase 9 stateless (idempotency через GitHub state), suppressionSet — единственное in-memory state (TTL 10min, bounded).
- v1.0 — fail-fast на bad env, degraded mode на connectivity. Onboarding на 401/404/403 — log + skip, не падает globally.
- v1.0 — no force-push, no protection bypass. Все 422 идут через GET-sha → re-PUT (D-07.7/8) или конвертируются в notify-fallback (D-09/10).
- v1.1 (STATE.md) — Onboarding runs **inline в webhook handler**, не в MultiQueue (подтверждено D-05, оригинальный «p-limit(2), cap 20 + остаток MultiQueue» переформулирован в D-03/04/05).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/webhook/handler.ts:5-23` — расширяем сигнатуру `registerHandlers(probot, deps)`, существующий log-call внутри остаётся.
- `src/webhook/multiQueue.ts:32` (lanes Map), `:145` (buildKey) — добавляем `clearByInstallation(id)` additive.
- `src/notify/dispatcher.ts` (MultiChannel) — конструктор расширяется опциональным `{suppressionCheck}`.
- `src/auth.ts:108` (`getInstallationOctokit`) — единственный auth-факторий, на нём базируется весь onboarding sequence.
- `src/config/schema.ts` — template `.github/auto-merge.yml` (D-26) должен проходить через тот же schema validator (unit test cover).
- `src/env.ts` SETUP_PUBLIC_URL (Phase 6) — используем для PR body /diagnose link (D-24).
- pino `log` — новые `onboard_*` events без новой инфраструктуры.

### Established Patterns
- Probot subscriber model: один `probot.on(event, handler)` per event (handler.ts:12); расширяем тем же шаблоном.
- Module-level cached state: `auth.ts` (createProbot), `config/loader.ts` (defaultLoader memoize) — `suppressionSet` следует тому же подходу (singleton, module-level).
- Additive расширения FROZEN: `BuildServerDeps` уже наращивался в Phase 6-8 без правки существующих полей (D-28 продолжает паттерн).
- Idempotent retry on 422: pattern `try create → catch 422 → GET sha → re-PUT` уже встречается в v1.0 cascade (orchestrator.ts merge flow); используем тот же подход в D-07.6/7.
- LRU с natural TTL вместо ручного cleanup: disabledRepos / sourceShaDedup / dedup — v1.0-established подход; следуем (D-16).

### Integration points
- `src/index.ts` boot: создаём `suppressionSet`, передаём `suppressionCheck` в `new MultiChannel(channels, {...})`, передаём `onboarding` в `buildServer`. Аналог Phase 6 healthChecker wiring.
- `src/server.ts:67` gate — onboarding mandatory когда основные deps присутствуют; никакой conditional gate (`SETUP_ENABLED` касается только setup-routes, не onboarding).

</code_context>

<deferred_ideas>
## Noted for Later

- Detection release-branch / staging / qa по name probes — отложено (увеличивает API budget при bulk install ради marginal UX win); template `.github/auto-merge.yml` оставляет release_branch закомментированным с инструкцией.
- Auto-update workflow/config файла в репо после v1.1 release — out of scope (v1.1 — initial bootstrap only). Реализация: сравнение SHA template'а с repo, открытие upgrade PR — отдельная phase.
- Re-key disabledRepos LRU по `installation_id/repo` — отвергнуто (правка FROZEN notify ради косметики). Если в будущем понадобится строгий per-installation tracking — отдельная phase с migration plan.
- Pre-flight `repos.getBranchProtection` — отвергнуто (extra API per репо при bulk install); реактивный 422-catch достаточен.
- Issue с инструкцией при protection-blocked репо — отвергнуто оператором; используем notify через env-level каналы.

</deferred_ideas>
