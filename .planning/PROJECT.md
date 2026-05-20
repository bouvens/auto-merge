# auto-merge

## What This Is

Self-hostable GitHub App для автоматического каскадного слияния веток: `main → release → dev` (или `main → dev`, если release-ветки нет). Заменяет привычный скрипт + PAT-токен на GitHub App с ограниченными permissions, аудитом и уведомлениями о конфликтах в Slack/Telegram. Для команд, у которых принят long-lived cascade-flow и нужна автоматизация без накопления токенов в репозитории.

## Core Value

Любой коммит, попавший в верхнюю ветку каскада, без участия человека доезжает до нижних веток — а если не доезжает (конфликт), команда сразу знает: кто, где, в каком репо, что чинить.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] **APP-01**: GitHub App с минимально необходимыми permissions (contents: write, pull_requests: write, checks: write, metadata: read), без хранения PAT
- [ ] **APP-02**: Self-host через Docker — один образ, запуск на любом VPS/k8s
- [ ] **CFG-01**: Конфигурация каждого репо лежит в `.github/auto-merge.yml` (GitOps-стиль), версионируется вместе с кодом
- [ ] **CFG-02**: Конфиг задаёт фиксированные имена веток каскада (`main`, `release_branch`, `dev_branch`) — имена могут быть любыми, не только канонические
- [ ] **CFG-03**: Если release-ветка не указана/не существует — каскад идёт `main → dev` напрямую
- [ ] **MERGE-01**: Каскадное слияние `main → release → dev` без force-push и без переписывания истории
- [ ] **MERGE-02**: Skip без действий, если в target нечего доливать (source уже в target)
- [ ] **MERGE-03**: При успешном merge — commit message содержит список влитых коммитов
- [ ] **TRIG-01**: Trigger 1 — push в main / release (webhook от GitHub)
- [ ] **TRIG-02**: Trigger 2 — расписание (cron) как страховка от пропущенных webhook
- [ ] **TRIG-03**: Trigger 3 — ручной запуск через `workflow_dispatch` (репо размещает у себя маленький workflow, дёргающий App)
- [ ] **CONF-01**: При конфликте — каскад на этой ветке останавливается, дальше по графу не идём
- [ ] **CONF-02**: При конфликте — App создаёт PR `source → target` с конфликтными файлами для ручного резолва
- [ ] **CONF-03**: При конфликте — в созданном PR/Issue упоминается автор последнего коммита (`@author`)
- [ ] **CONF-04**: При конфликте — отправляется уведомление в Slack и Telegram с автором, ветками, ссылкой на PR
- [ ] **NOTIF-01**: Slack-уведомления через webhook URL (bot token хранится в env инстанса App)
- [ ] **NOTIF-02**: Telegram-уведомления через bot API (bot token — в env инстанса App, chat_id — в `.github/auto-merge.yml` каждого репо)
- [ ] **NOTIF-03**: Уведомления отправляются только при ошибках/конфликтах (успех — без шума)
- [ ] **OBS-01**: Каждая попытка merge публикуется как GitHub Check Run на исходном коммите (видно в PR/коммит-листе GitHub нативно)

### Out of Scope

- **Marketplace-листинг** — приложение публикуется без Marketplace, инсталляция и Homepage URL — самостоятельно (README/wiki/портал)
- **Multi-tenant SaaS-хостинг от нас** — каждая команда хостит свой инстанс (Docker)
- **Внешний веб-dashboard (UI приложения)** — записано в идеи на будущее; в v1 GitHub-native UI (Check Runs, Issues, PR-комментарии) + Slack/Telegram достаточно
- **Шифрованное хранилище секретов на стороне App** — bot tokens в env инстанса (1 Slack + 1 Telegram на инстанс), отдельная БД секретов не нужна
- **Pattern-matching имён release-веток (glob/regex)** — поддерживаем только фиксированное имя из конфига; pattern-режим — на будущее
- **Произвольный граф каскадов (`main → qa → uat → dev` и т.п.)** — v1 поддерживает только цепочку из 2-3 веток (main, optional release, dev); расширение графа — позже
- **Уведомления об успешных мерджах и daily-digest** — на будущее, чтобы не шуметь в чатах
- **Назначение assignee при конфликте** — пока ограничиваемся @mention автора (assignee требует доп. permissions и не всегда есть права)
- **Email-уведомления** — Slack/Telegram покрывают целевую аудиторию
- **Issue/PR slash-commands (`/auto-merge`)** — `workflow_dispatch` покрывает кейс ручного запуска без доп. парсинга
- **REST endpoint для внешнего триггера** — `workflow_dispatch` достаточно
- **Auto-resolve конфликтов (стратегии типа `-X theirs`)** — рискованно, ручной резолв безопаснее

## Context

- Существуют bash-скрипты, реализующие подобный flow через PAT-токен и GitHub Actions. Минусы: токены живут в Secrets репо, имеют широкие права, привязаны к человеку, легко утекают. GitHub App решает это: installation token короткоживущий, permissions ограничены, ставится один раз на org.
- Целевые команды — те, у кого long-lived cascade-flow: разработка идёт в `dev`, релизы готовятся в `release`, продакшен на `main`. Hotfix в main должен немедленно доехать до release и dev, чтобы не оторвалась ветка разработки.
- Имя release-ветки в разных репо может отличаться: `release`, `staging`, `qa`, `pre-prod`. Поэтому имена — конфигурируемые.
- Чаты Slack/Telegram у разных команд внутри одной org обычно разные. Поэтому `chat_id`/`channel` — per-repo в YAML.
- Self-host Docker даёт командам контроль над инфраструктурой и не требует от нас держать SaaS, биллинг, поддержку.

## Constraints

- **Tech stack**: Node.js + TypeScript — стандартный путь для GitHub Apps (Octokit, Probot экосистема), масса библиотек, типобезопасность
- **Hosting**: Self-host Docker — один образ должен подниматься на любом VPS / k8s одной командой `docker run`, без managed-зависимостей
- **Security**: GitHub App не имеет доступа к репо-Secrets (это ограничение GitHub) — поэтому Slack/Telegram bot tokens принципиально лежат в env инстанса App, а не в репо
- **Permissions (GitHub App)**: минимальные — `contents: write` (для merge/push), `pull_requests: write` (создавать PR при конфликтах), `checks: write` (Check Runs), `metadata: read`. Никаких `admin`, `secrets`, `actions: write`
- **Operations**: без переписывания истории, без force-push, без `--no-verify` — merge должен выглядеть как обычный merge commit
- **Compatibility**: каскад v1 — линейная цепочка до 3 звеньев (main → [release] → dev); расширение графа — следующая веха
- **Auditability**: каждое действие App видно либо как commit в target-ветке, либо как Check Run, либо как PR — никаких «тихих» операций

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| GitHub App вместо PAT + Actions | Короткоживущие installation tokens, ограниченные permissions, нет утечки человеческих токенов | — Pending |
| Конфигурация в `.github/auto-merge.yml` (GitOps) | Версионируется с кодом, не требует БД, прозрачно для команды | — Pending |
| Bot tokens — в env инстанса App | GitHub App не читает репо-Secrets; per-tenant deploy делает это безопасным | — Pending |
| Без внешнего dashboard в v1 | GitHub-native UI (Check Runs, Issues, PR) + Slack/Telegram покрывают наблюдаемость | — Pending |
| Фиксированные имена веток в конфиге, без pattern-matching | Простая и предсказуемая семантика; pattern — на будущее | — Pending |
| При конфликте — создаём PR + останавливаем каскад + tag автора | Не пытаемся «угадать» резолв; даём команде ясный артефакт для починки | — Pending |
| Ручной запуск через workflow_dispatch | Не нужно строить кастомный API/auth; «кнопка Run workflow» в GitHub Actions UI знакома команде | — Pending |
| Node.js + TypeScript | Стандартный стек для GitHub Apps, Octokit/Probot, типобезопасность | — Pending |
| Self-host Docker | Полный контроль команды над инфраструктурой и секретами, нет SaaS-обязательств | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-20 after initialization*
