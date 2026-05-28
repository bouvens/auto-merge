<!-- GSD:project-start source:PROJECT.md -->
## Project

**auto-merge**

Self-hostable GitHub App для автоматического каскадного слияния веток: `main → release → dev` (или `main → dev`, если release-ветки нет). Заменяет привычный скрипт + PAT-токен на GitHub App с ограниченными permissions, аудитом и уведомлениями о конфликтах в Slack/Telegram. Для команд, у которых принят long-lived cascade-flow и нужна автоматизация без накопления токенов в репозитории.

**Core Value:** Любой коммит, попавший в верхнюю ветку каскада, без участия человека доезжает до нижних веток — а если не доезжает (конфликт), команда сразу знает: кто, где, в каком репо, что чинить.

### Constraints

- **Tech stack**: Node.js + TypeScript — стандартный путь для GitHub Apps (Octokit, Probot экосистема), масса библиотек, типобезопасность
- **Hosting**: Self-host Docker — один образ должен подниматься на любом VPS / k8s одной командой `docker run`, без managed-зависимостей
- **Security**: GitHub App не имеет доступа к репо-Secrets (это ограничение GitHub) — поэтому Slack/Telegram bot tokens принципиально лежат в env инстанса App, а не в репо
- **Permissions (GitHub App)**: минимальные — `contents: write` (merge/push), `pull_requests: write` (PR при конфликтах), `checks: write` (Check Runs), `metadata: read`, `administration: read` (pre-flight по branch protection rules перед merge). Никаких `administration: write`, `secrets`, `actions: write`
- **Operations**: без переписывания истории, без force-push, без `--no-verify` — merge должен выглядеть как обычный merge commit
- **Compatibility**: каскад v1 — линейная цепочка до 3 звеньев (main → [release] → dev); расширение графа — следующая веха
- **Auditability**: каждое действие App видно либо как commit в target-ветке, либо как Check Run, либо как PR — никаких «тихих» операций
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Executive Recommendation
## Recommended Stack
### Core Technologies
| Technology | Version | Purpose | Why Recommended |
|---|---|---|---|
| Node.js | **22.x LTS** (22.22+) | Runtime | Active LTS until 2027-04. Native `fetch`, `node:test`, `--env-file`, stable `node --watch`. Node 24 just went LTS in 2026-04 but most Alpine images still ship 22; stay on 22 for one cycle. |
| TypeScript | **5.8.5** | Language | Stable. Use `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, ESM. `verbatimModuleSyntax: true`. |
| Probot | **14.3.2** | GitHub App framework | Wraps webhook signature verification, JWT minting, installation-token caching, throttling+retry plugins. Maintained (2026-04 release). Mount inside Fastify via `probot.receive()`. |
| Fastify | **5.8.5** | HTTP server | Schema validation, hooks, raw-body access for webhook HMAC, JSON Schema → TypeBox/zod compatible. Native Node 22. |
| @octokit/auth-app | **8.2.0** | App + installation token auth | Transitively via Probot, but pin explicitly — needed for cron/dispatch paths that don't go through webhook context. |
| @octokit/plugin-throttling | **11.0.3** | Rate-limit handling | GitHub returns `X-RateLimit-*` + secondary-rate-limit headers; this plugin queues automatically. Already bundled by Probot. |
| @octokit/plugin-retry | **8.1.0** | Network/5xx retries | Exponential backoff on 502/503/504. Bundled by Probot. |
### Supporting Libraries
| Library | Version | Purpose | When to Use |
|---|---|---|---|
| **croner** | **10.0.1** | Cron scheduler | In-process cron for the safety-net trigger (TRIG-02). No DB, no Redis. POSIX cron syntax + timezone support. Pure JS, zero deps. Better than `node-cron` (see "What NOT to Use"). |
| **pino** | **10.3.1** | Structured logging | Industry standard for Node. JSON output → ship to any aggregator. ~5× faster than winston. Use `pino-pretty` only in dev. |
| **zod** | **4.4.3** | Runtime validation | Validate `.github/auto-merge.yml`, webhook payloads we care about, env vars. Zod 4 is current (smaller bundle, faster than v3). |
| **yaml** | **2.9.0** | YAML parser | `eemeli/yaml` — actively maintained, supports YAML 1.2, gives source-position info for good error messages on bad configs. Do NOT use `js-yaml` (older, less precise errors). |
| **undici** | **7.x** | HTTP client for Slack/Telegram | Built into Node 22 as global `fetch`. Just use `globalThis.fetch` — no need to install `undici` explicitly unless we want connection-pool tuning. |
| **@fastify/raw-body** | **^5.0.0** | Raw body capture | Required: webhook HMAC must be computed over the unparsed body. |
| **dotenv** | **17.x** *(dev only)* | Local env loading | Production uses Docker env vars / k8s secrets. In Node 22+, prefer `node --env-file=.env`; keep `dotenv` only if you need `.env.local` overlay. |
### GitHub App Specifics
| Concern | Choice | Rationale |
|---|---|---|
| Webhook signature verification | Probot built-in (uses `@octokit/webhooks` + `crypto.timingSafeEqual`) | Don't roll your own HMAC. |
| Installation token caching | Probot built-in (in-memory LRU, 1-hour TTL) | Tokens are short-lived; in-memory is fine for single-instance. If you ever scale to N replicas, swap to a shared store (out of scope v1). |
| Git merge | `octokit.rest.repos.merge({ owner, repo, base, head })` | Server-side merge, 409 = conflict, 204 = nothing to merge (handles MERGE-02 for free), 201 = merged. No local clone, no `git` binary in image. |
| Check Runs | `octokit.rest.checks.create/update` | Native; required for OBS-01. |
| PR on conflict | `octokit.rest.pulls.create` + `octokit.rest.issues.createComment` for `@author` mention | Standard. |
| Conflict commit author | `octokit.rest.repos.getCommit(sha).data.author.login` | Falls back to `commit.author.email` if GitHub user not linked. |
### Notifications
| Service | Library | Why |
|---|---|---|
| Slack | **None — use `fetch` directly to incoming-webhook URL** | A Slack incoming webhook is one HTTP POST with a JSON body. `@slack/webhook` is 200 LOC of wrapper for a 5-LOC call. Avoids the entire `@slack/*` dependency tree. |
| Telegram | **None — use `fetch` directly to `api.telegram.org/bot<token>/sendMessage`** | Same logic. `telegraf`/`grammy` are bot frameworks (polling, updates, sessions) — overkill for "send one message". Direct API call is 10 LOC. |
### Development Tools
| Tool | Version | Purpose | Notes |
|---|---|---|---|
| **tsx** | **4.22.3** | Dev runner | `tsx watch src/index.ts`. Faster than `ts-node`, no config needed. Dev only. |
| **tsc** | **5.8.5** | Production build | `tsc --project tsconfig.build.json` emits to `dist/`. Run `node dist/index.js` in container. Do NOT use `tsx` in production (slower cold start, larger image). |
| **vitest** | **4.1.7** | Test runner | Fast, ESM-native, `vitest --coverage` built in, compatible Jest-style API. Has built-in mock/spy. |
| **msw** | **2.14.6** | GitHub API mocking | Intercepts `fetch` at the network layer. Tests are deterministic regardless of Octokit version. Use over `nock` (which patches `http` and is fragile with `undici`/`fetch`). |
| **smee-client** | **^2.0.0** | Local webhook forwarding | `smee.io` proxy for dev — receives webhooks at a public URL and forwards to localhost. Dev only. |
| **biome** | **2.4.15** | Linter + formatter | Single tool, single config, ~25× faster than ESLint+Prettier. Native TS. Drop-in for new projects. Use over ESLint+Prettier unless you need a specific ESLint plugin biome doesn't cover yet. |
| **@types/node** | **22.x** | Node typings | Match runtime major. |
## Installation
# Core
# Dev
## Project Layout
## Docker
# Stage 1: build
# Stage 2: runtime
- Alpine: ~50 MB final image, has `sh` for debugging via `docker exec`, `npm` available if you need to inspect.
- Distroless (`gcr.io/distroless/nodejs22`): ~120 MB, no shell, debugging requires sidecar containers. Marginal security win not worth the ops friction for a self-hosted tool that admins will troubleshoot.
- If your team mandates distroless: use `gcr.io/distroless/nodejs22-debian12:nonroot`. Everything still works (we don't shell out anywhere).
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|---|---|---|
| Probot | Raw `@octokit/app` + `@octokit/webhooks` | If you need to support multiple webhook formats or non-GitHub events. We don't. |
| Fastify | Hono | If you need to deploy to Cloudflare Workers / Bun / Deno. We ship Docker-on-Node. |
| Fastify | Express 5 | If your team is deeply Express-fluent and the org standard. Fastify wins on schema validation + raw body. |
| Octokit `repos.merge` | `simple-git` local clones | If you ever need auto-resolve strategies, partial cherry-picks, or rebase. None are in scope. |
| Octokit `repos.merge` | `isomorphic-git` (pure-JS git) | If you need to inspect tree contents without API calls. Adds 2 MB and complexity for no current use case. |
| croner | node-cron | node-cron 4.x is fine but croner has timezone done right and zero deps. |
| croner | BullMQ / agenda | Both require Redis/MongoDB. Constraint: no DB. |
| zod | valibot | valibot wins on bundle size (~1 KB vs ~30 KB). Server-side, bundle size is irrelevant. zod's ecosystem and error format are richer. |
| yaml (eemeli) | js-yaml | js-yaml works but error messages lack column info; eemeli/yaml gives `{ line, col, message }` per parse error → friendlier YAML feedback to users. |
| Biome | ESLint + Prettier | If a specific ESLint plugin is mandatory (e.g. `eslint-plugin-import-x` for strict import ordering Biome doesn't yet enforce identically). |
| msw | nock | Legacy tests. nock patches `http`/`https` modules and has flaky interactions with `undici`/`fetch`. |
| Direct fetch for Slack | `@slack/webhook` | If you start using interactive payloads, blocks, modals. v1 sends text + one link — no need. |
| Direct fetch for Telegram | `grammy` / `telegraf` | If we ever build interactive Telegram bot (inline keyboards, commands). v1 only sends notifications. |
| node 22 LTS | node 24 LTS | node 24 went LTS 2026-04-22. Wait one minor cycle — Alpine and Docker official images take 4-6 weeks to stabilise. Switch at the next milestone. |
## What NOT to Use
| Avoid | Why | Use Instead |
|---|---|---|
| **PAT (Personal Access Token) auth** | Explicitly the thing we're replacing. Broad permissions, tied to a human, leaks via repo Secrets. | GitHub App installation token (Probot handles minting). |
| **`@octokit/rest` (the standalone package)** | Superseded by `octokit` meta-package and by Probot's pre-wired Octokit. Adds a redundant dep tree. | `context.octokit` from Probot. |
| **node-cron 3.x** | Older API, less maintained. | croner. (node-cron 4.x is acceptable if you already know it.) |
| **agenda / Bull / BullMQ** | Require MongoDB / Redis. Hard constraint: no DB. | croner in-process. |
| **node-telegram-bot-api** | Uses long-polling by default, drags in `request` (deprecated), maintenance is spotty. | Direct `fetch` to bot API. |
| **`request` / `axios`** | `request` is deprecated; `axios` has had supply-chain issues and is unnecessary on Node 22+. | Built-in `fetch` (undici). |
| **js-yaml** | Lower-quality error positions; slower YAML 1.2 features support. | `yaml` (eemeli). |
| **Jest** | Slow on ESM, requires `ts-jest` or Babel, painful TS config. | vitest. |
| **nock** | Patches Node's `http` module — fragile with `undici`/native `fetch`. | msw. |
| **ts-node / ts-node-dev** | Slower than tsx, more config. | tsx (dev) + tsc (prod). |
| **ESM + CommonJS mixing** | Octokit, Probot, Fastify 5 are all ESM-only as of 2026. Going CJS forces `require()` of ESM, which breaks. | Pure ESM. `"type": "module"` in package.json. |
| **Running `tsx` in production** | Higher memory, slower startup, no incremental advantage once tsc has emitted. | `node dist/index.js`. |
| **Bundling the server with webpack/rollup** | Octokit's plugin loading uses dynamic patterns that occasionally fail under bundlers. Image-size savings are negligible at this scale. | Plain `tsc` output. |
| **`@slack/bolt`** | Full Slack app framework with sockets, listeners, OAuth. We send one notification. | `fetch` to incoming webhook URL. |
| **Storing state in a DB** | Out of scope; adds ops burden. State that matters lives in GitHub (PRs, Check Runs, commits). | Stateless service + idempotent operations keyed by commit SHA. |
| **Force-push / `--no-verify` / history rewrite** | Explicit constraint in PROJECT.md. | `octokit.repos.merge` — merge commit only. |
## Stack Patterns by Variant
- Use Express 5, mount Probot via the official `createNodeMiddleware` adapter from `@octokit/webhooks`.
- Lose Fastify's schema validation — add `zod` manually at route boundaries.
- Replace in-process croner with a `CronJob` resource and a dedicated `/cron/run` endpoint that the job hits.
- Webhook receiver scales freely (stateless). Cron must be singleton.
- Installation token cache stays in-memory per replica (slight inefficiency — each replica re-mints on first use within the hour; acceptable).
- Add `simple-git` (3.x), `git` binary in the Docker image (`apk add git`), use shallow clones to `/tmp/repo-<id>`, clean up in `finally`.
- This is documented as PITFALLS-worthy: see PITFALLS.md.
## Version Compatibility
| Package | Compatible With | Notes |
|---|---|---|
| Node 22.x | All listed deps | All packages tested on Node 20+/22+. |
| Probot 14.3.x | @octokit/* v7-v17 (transitively) | Probot 14 pins its octokit deps; don't pin them separately or you'll get duplicate trees. Let `@octokit/auth-app` be a direct dep only for the cron path. |
| Fastify 5.x | Node ≥ 20 | Fastify 5 dropped Node 18. |
| zod 4.x | Node ≥ 18 | zod 4 API is mostly compatible with 3; check `z.string().email()` → `z.email()` rename if upgrading. |
| Vitest 4.x | Node ≥ 20.11 | Uses native ESM. |
| Biome 2.x | Any | Standalone binary, no Node version coupling. |
| `octokit` meta vs `@octokit/app` directly | Pick one path | We pick `@octokit/app` (via Probot) — do not also import `octokit`. |
## Sources
- `/probot/probot` (Context7, High reputation, 255 snippets) — verified `Probot.receive()` exists, framework is mounted-server-friendly, and confirmed active maintenance via npm `time` (14.3.2 published 2026-04-03).
- `/octokit/octokit.js` (Context7) — confirmed octokit meta-package, App auth flow.
- `/fastify/fastify` (Context7, 831 snippets, HIGH reputation) — schema validation, raw-body pattern.
- npm registry (queried live 2026-05-20) — pinned versions:
- GitHub REST API docs — `POST /repos/{o}/{r}/merges` returns 201 (created), 204 (nothing to merge), 409 (conflict), 404 (missing branch). Behaviour exactly matches MERGE-01/02/03 requirements.
- Node.js release schedule (nodejs.org/about/previous-releases) — Node 22 Active LTS until 2027-04-30; Node 24 LTS started 2026-04-22 (too fresh for Alpine official tags as of research date).
- HIGH: framework choice (Probot+Fastify), Octokit decision, cron lib, validation lib, testing lib, Docker base — all verified against current Context7 + npm + official docs.
- HIGH: anti-recommendations — all based on either explicit project constraints (no DB) or current ecosystem state (nock vs msw, Jest vs vitest).
- MEDIUM: Node 22 vs 24 — Node 24 just became LTS; recommendation to wait one cycle is conservative, not authoritative.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
