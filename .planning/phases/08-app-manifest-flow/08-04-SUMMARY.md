---
phase: 08-app-manifest-flow
plan: 04
subsystem: setup
tags: [setup, manifest, csrf, html, fastify]
requires:
  - 08-01 (env vars + scaffold)
  - 08-02 (html/csrf/manifestSchema helpers)
  - 08-03 (credentials store + boot stale check)
provides:
  - setup/manifestForm.renderManifestForm
  - setup/manifestForm.renderWarningPage
  - setup/manifestForm.registerManifestFormRoute
affects:
  - src/setup/manifestForm.ts (NEW)
  - test/unit/setup-manifest-form.test.ts (NEW)
tech_stack_added: []
patterns_used:
  - inline-html-template-literal (D-15)
  - zod-narrow-query-parse (no any)
  - single-randomUUID cookie ↔ manifest.state binding
  - object/conditional expr for org URL (CLAUDE.md: no switch)
key_files_created:
  - src/setup/manifestForm.ts
  - test/unit/setup-manifest-form.test.ts
key_files_modified: []
decisions:
  - D-06 cookie+manifest.state from one randomUUID
  - D-07 cookie attrs already in csrf.ts (reused)
  - D-10 org regex ^[a-zA-Z0-9-]{1,39}$
  - D-12 duplicate guard on credentials.exists()
  - D-13 typed-confirmation override (force=1 + confirm=SETUP_APP_NAME)
  - D-14 setup_overwrite WARN log (no secrets)
  - D-15 inline TS template literal, no template engine
  - D-18 future wiring point (routes.ts → server.ts) deferred to Plan 06
metrics:
  duration_minutes: 12
  tasks_completed: 2
  files_touched: 2
  tests_added: 21
  completed_at: 2026-05-23T22:00:00Z
---

# Phase 08 Plan 04: GET /setup/new — manifest form + duplicate guard Summary

One-liner: GET /setup/new returns an auto-submitting HTML form POSTing GitHub App manifest JSON to github.com (personal or org-scoped), gated by a typed-confirmation warning page when credentials.env already exists, with CSRF state bound between Set-Cookie and the embedded manifest.

## What was built

`src/setup/manifestForm.ts` exports three symbols:

- **`renderManifestForm(env, state, org?): string`** — pure HTML renderer. Returns `<!doctype html>...` with a single `<form method="post">` whose `action` is `https://github.com/settings/apps/new` (no org) or `https://github.com/organizations/${org}/settings/apps/new`. Embeds the result of `buildManifest(env, state, org)` as a hidden `<input name="manifest">` whose value goes through `jsonForHtmlAttr` (HTML-escape of `JSON.stringify`). Includes an auto-submit `<script>`.
- **`renderWarningPage(env, existingPath): string`** — pure HTML renderer. Russian user-facing copy ("App уже сконфигурирован" headline + 4-step recovery `<ol>` + override form with hidden `force=1` and typed `confirm` input). All env/path interpolations pass through `escapeHtml`.
- **`registerManifestFormRoute(app, { env, log, credentials })`** — Fastify route handler. Parses `?org` (zod `/^[a-zA-Z0-9-]{1,39}$/`) → 400 `{ error: "invalid_org" }` on mismatch. Calls `credentials.exists()` — if true and `force=1 && confirm===SETUP_APP_NAME` is NOT both satisfied, returns warning page (no Set-Cookie). On override path: logs `setup_overwrite` WARN. Fresh path: mints one `randomUUID()`, writes it to both the state cookie and the embedded manifest JSON, returns manifest form.

## Behaviour verified (21 tests, all green)

| Scenario | Status |
|----------|--------|
| `renderManifestForm` returns `<!doctype html>` + correct personal URL | ✓ |
| `renderManifestForm` org=`acme` → action contains `organizations/acme` | ✓ |
| Manifest JSON round-trips through HTML-attr encoding (state preserved) | ✓ |
| `SETUP_APP_NAME='<img src=x>'` → no raw `<img` in visible text | ✓ |
| Auto-submit `<script>...submit()...</script>` present | ✓ |
| Pure functions — same args → byte-identical output (manifest + warning) | ✓ |
| Warning page: Russian headline, escaped existingPath, 4+ `<li>` steps | ✓ |
| Warning page: override form (method=get, action=/setup/new, force=1 hidden, confirm text input) | ✓ |
| `GET /setup/new` 200 HTML + state cookie + Cache-Control no-store + setup_started log | ✓ |
| `GET /setup/new?org=acme` 200 with org-scoped action | ✓ |
| `?org=../bad` → 400 invalid_org, no Set-Cookie | ✓ |
| `?org=<40 chars>` → 400 invalid_org | ✓ |
| State binding: Set-Cookie value === manifest JSON.state | ✓ |
| credentials.env exists, no `?force=1` → warning page, no Set-Cookie state, no setup_overwrite log | ✓ |
| credentials.env exists, `?force=1` without confirm → warning page, no overwrite log | ✓ |
| `?force=1&confirm=<SETUP_APP_NAME>` → manifest form + cookie + setup_overwrite WARN | ✓ |
| `?force=1&confirm=wrong-name` → silent warning fallback, no overwrite log | ✓ |

## Decisions made

- **Single `randomUUID()`** for both Set-Cookie and manifest `state` field — minted once per request, never reused (D-06). Cookie attributes already encoded in `setStateCookie` from Plan 02; reused as-is.
- **Org URL via conditional expression**, not `switch`/`if-else` block (CLAUDE.md object-over-switch rule).
- **Inline `<script>` auto-submit** instead of `<form ... onload>` — `onload` doesn't fire on `<form>` in browsers; querying after parse is the only reliable path.
- **`<noscript><button>Продолжить</button></noscript>`** added defensively — operators with JS disabled (rare in admin contexts but possible) still get a manual continue button.
- **Silent fallback on `confirm` mismatch** (per behaviour spec) — wrong confirm value is indistinguishable from no confirm at all; the typed-confirmation mismatch never logs (D-14 only logs on successful override).
- **Tests share a single file** (`setup-manifest-form.test.ts`) covering both pure renderers (Task 1) and the route handler (Task 2). Plan asked for both, and the fixture/decode helper is shared.

## Threat model coverage

- T-08-13 (org path traversal): zod regex rejects `..`, `/`, encoded slashes → test injects `..%2Fbad` → 400.
- T-08-14 (CSRF state binding): single `randomUUID()` written to both Set-Cookie and `state` field → test extracts both and asserts equal.
- T-08-15 (XSS via env/query interpolation): `escapeHtml` on every interpolation → test injects `<img src=x>` in `SETUP_APP_NAME` → no raw `<img` in visible-text portion.
- T-08-16 (unauditable overwrite): `log.warn({event:"setup_overwrite", previous_path})` fires only on full typed-confirmation match.
- T-08-17 (warning page path disclosure): accepted — operator-controlled config.
- T-08-18 (cookie reuse): `Max-Age=600` from `setStateCookie` (Plan 02).

## Deviations from plan

None. Plan executed exactly as written:

- Behaviour bullets — all 16 covered by 21 tests.
- Acceptance criteria — `grep -c 'switch (' src/setup/manifestForm.ts` returns 0; `grep -c 'as any\|: any' src/setup/manifestForm.ts` returns 0; `grep -c 'randomUUID' src/setup/manifestForm.ts` returns 2.
- `npx tsc --noEmit` — clean.
- `npx vitest run test/unit/setup-manifest-form.test.ts` — 21/21 pass.

## Deferred to subsequent plans

- **Route wiring into `src/server.ts`** — Plan 06 will add the `if (deps.env.SETUP_ENABLED) { registerManifestFormRoute(app, ...) }` block per D-18, alongside `/setup/callback` and `/setup/credentials.env`. This plan's route is NOT yet exposed to the running server.
- **`registerSetupRoutes` aggregator** — will live in `src/setup/routes.ts` (Plan 06 per PATTERNS map); current `registerManifestFormRoute` is the building block.

## Commits

| Commit | Message |
|--------|---------|
| `170a711` | test(08-04): add failing test for setup manifest form + warning page |
| `c870e6c` | feat(08-04): GET /setup/new manifest form + duplicate-setup warning page |

## Self-Check: PASSED

- `[x]` `src/setup/manifestForm.ts` exists.
- `[x]` `test/unit/setup-manifest-form.test.ts` exists.
- `[x]` Commit `170a711` (test, RED) present in `git log`.
- `[x]` Commit `c870e6c` (feat, GREEN) present in `git log`.
- `[x]` `npx vitest run test/unit/setup-manifest-form.test.ts` — 21/21 green.
- `[x]` `npx tsc --noEmit` — no type errors.
- `[x]` No `any` (`grep -nE 'as any|: any' src/setup/manifestForm.ts` empty).
