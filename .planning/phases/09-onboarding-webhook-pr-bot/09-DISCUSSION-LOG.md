# Phase 9 — Discussion Log

**Session date:** 2026-05-24
**Mode:** `discuss-phase 9 --chain`

## Areas discussed

1. Overflow механизм (SC2)
2. Branch-protection fallback (SC4)
3. installation.deleted cleanup (SC5)
4. Notify suppression механизм (ONBOARD-04)

---

## Area 1: Overflow / throughput control

**Context surfaced:**
- ROADMAP SC2: «p-limit(2), cap 20 sync + остаток через MultiQueue low-priority».
- ARCHITECTURE Q2: «Do NOT enqueue onboarding into MultiQueue. … add a small standalone semaphore».
- PITFALL-4: «queue the rest via croner (5/min)».
- STATE.md v1.1 Key Decisions: повторяет ROADMAP.

**Options presented:**
1. Dedicated onboarding queue + croner drain (FROZEN-friendly, отрезает MultiQueue из SC2)
2. Standalone semaphore, всё sync в webhook (p-limit(2) на batch, без cap 20, fire-and-forget)
3. Extend MultiQueue буквально (priority field, нарушает FROZEN)

**User choice:** Option 2 — standalone semaphore, всё sync в webhook.

**Resulting decisions:** D-03, D-04, D-05, D-06. SC2 reinterpreted.

---

## Area 2: Branch-protection fallback (SC4)

**Context surfaced:**
- ROADMAP SC4: «создаётся Issue с draft-содержимым и инструкцией».
- PITFALL-7: prefers Check Run instead of Issue.
- ARCHITECTURE Q6: «on 403 abort+log».

**Options presented (round 1):**
1. Reactive 422/403 catch → Issue (inline YAML+workflow)
2. Pre-flight `getBranchProtection` → Issue или PR-branch
3. Hybrid: reactive + cache

**User response (round 1):** «никаких ишью. Какой ещё дороже баджет?» — отверг все варианты с Issue, API budget признал нерелевантным.

**Options presented (round 2):** что делаем вместо Issue?
1. Check Run на default-branch HEAD
2. Silent skip + WARN log
3. Notify в Slack/Telegram + WARN log

**User choice (round 2):** Option 3 — Notify в Slack/Telegram + WARN log.

**Follow-up by Claude (no question — recorded as decision):** reactive 422/403 catch (не pre-flight) выбран по умолчанию — экономия 1 API call/репо при bulk install при минимальной дельте по UX. Notify через global env-level (обходя repo-config), потому что `.github/auto-merge.yml` ещё не существует на момент onboarding.

**Resulting decisions:** D-09, D-10, D-11. SC4 reinterpreted (Issue → notification).

---

## Area 3: `installation.deleted` cleanup (SC5)

**Context surfaced:**
- ROADMAP SC5: «MultiQueue slot и disabledRepos LRU per-installation очищены».
- MultiQueue ключ: `${installation_id}/${owner}/${repo}` — installation_id есть.
- disabledRepos LRU keyed by `owner/repo` slug — **installation_id отсутствует**.
- sourceShaDedup keyed by `owner/repo@sha` — installation_id отсутствует.
- dedup LRU keyed by `delivery_id` — installation_id отсутствует.

**Options presented (round 1):**
1. Только MultiQueue (clearByInstallation API)
2. MultiQueue + iterate disabledRepos
3. Re-key disabledRepos по installation_id/repo (нарушает FROZEN notify)

**User response (round 1):** «как лучше и правильнее?» — запросил рекомендацию.

**User question (clarification):** «что вообще за ключ?»

**Claude explained:**
- MultiQueue lanes keyed by `${installation_id}/${owner}/${repo}` — per-installation cleanup механически возможен.
- disabledRepos LRU keyed by `owner/repo` slug — per-installation cleanup физически невозможен без re-key (= правка FROZEN notify).
- LRU имеют natural TTL 24h, мусор сам уходит.

**Recommendation by Claude:** Option 1 — additive `MultiQueue.clearByInstallation(id)`, LRU на natural TTL, SC5 переформулируем.

**User choice (round 2):** «1» — принято.

**Resulting decisions:** D-15, D-16, D-17. SC5 reinterpreted (LRU exclusion).

---

## Area 4: Notify suppression mechanism (ONBOARD-04)

**Context surfaced:**
- ONBOARD-04: «Suppress cascade-conflict уведомления во время onboarding (флаг в context)».
- Onboarding handler сам notify не вызывает; вызывает cascade orchestrator при параллельных push'ах.
- MultiQueue worker работает в отдельном async-контексте — ALS не пропагирует сквозь очередь.

**Options presented:**
1. Per-installation TTL-Set + check в dispatcher (Set<installation_id> с TTL 10min, MultiChannel читает через DI callback)
2. Call-arg на notify.notify({suppress: true}) — отвергнут заранее (передавать через MultiQueue некому)
3. AsyncLocalStorage — отвергнут заранее (не пропагирует сквозь очередь)

**User choice:** Option 1 — Per-installation TTL-Set + check в dispatcher.

**Resulting decisions:** D-18, D-19, D-20, D-21.

---

## Deferred Ideas

- Release-branch detection по name probes
- Auto-update workflow/config файла в репо после v1.1
- Re-key disabledRepos LRU по installation_id/repo
- Pre-flight `repos.getBranchProtection`
- Issue с инструкцией при protection-blocked репо (отвергнуто оператором)

---

## Claude's Discretion (left for planner)

- Precise constructor signature for `MultiChannel` (options-object vs positional arg)
- Concrete API shape `notifyEnvLevel` (D-11)
- Log event names consistency (`onboard_*` prefix)
- Backoff helper implementation in `tokenRetry.ts`
- PR body wording (D-24)
- Test mock strategy (msw setup, fake timers)
