---
phase: 08-app-manifest-flow
plan: 06
subsystem: setup
tags: [wiring, integration, csrf, boot, composition]
requires:
  - "Plan 08-01: env schema (SETUP_ENABLED, SETUP_PUBLIC_URL, SETUP_OUTPUT_DIR, SETUP_APP_NAME)"
  - "Plan 08-02: csrf cookie helpers (state + download)"
  - "Plan 08-03: CredentialsStore + checkStaleOnBoot"
  - "Plan 08-04: registerManifestFormRoute (GET /setup/new + warning page)"
  - "Plan 08-05: registerManifestCallbackRoute + registerCredentialsDownloadRoute"
provides:
  - "registerSetupRoutes(app, deps) composition entry point"
  - "BuildServerDeps.credentials optional field"
  - "Boot-time stale credentials cleanup before app.listen() (D-04)"
  - "End-to-end test fixture for Phase-9 onboarding to build on"
affects:
  - src/server.ts (BuildServerDeps + conditional registration after webhook block)
  - src/index.ts (boot order extended with SETUP_ENABLED-guarded block)
tech-stack:
  added: []
  patterns:
    - "Composition-root module (src/setup/routes.ts) consolidates register* calls"
    - "Additive BuildServerDeps extension mirrors Plan 1.0 webhook-deps cluster gating"
    - "msw onUnhandledRequest:'error' for deterministic e2e"
key-files:
  created:
    - src/setup/routes.ts
    - test/integration/setup-flow.test.ts
  modified:
    - src/server.ts
    - src/index.ts
decisions:
  - "D-04: checkStaleOnBoot runs synchronously before app.listen() so first request never sees a stale file"
  - "D-18: BuildServerDeps gains optional credentials field — additive, zero regression"
  - "D-19: setup routes registered AFTER /webhook block, BEFORE return app — preserves health-route precedence and webhook-cluster gating"
  - "Defence in depth: server.ts logs warn + skip when SETUP_ENABLED=true but credentials store missing; primary invariant enforced at boot layer (index.ts always pairs flag + store)"
metrics:
  duration_seconds: 207
  completed_date: "2026-05-23T17:12:16Z"
  task_count: 3
  files_created: 2
  files_modified: 2
  tests_added: 6
  total_tests_after: 522
---

# Phase 8 Plan 06: Wiring (routes.ts + server.ts gate + index.ts boot + e2e) Summary

One-liner: composition root + conditional registration + boot-time stale cleanup + e2e proof that the full manifest flow round-trips through `app.inject` with msw.

## Composition root (Task 1)

`src/setup/routes.ts` exports a single `registerSetupRoutes(app, {env, log, credentials})` that calls the three Plan-04/05 register helpers in journey order (form → callback → download). Fastify imposes no order; the order is for human readability.

## server.ts gate (Task 1)

Insertion point: AFTER the existing `if (deps.probot && deps.dedup && deps.queue && deps.notify) {...}` webhook block, BEFORE `return app;`. The new gate fires only when `env.SETUP_ENABLED === true`; when the flag is true but the credentials store was not passed in, a `setup_routes_skipped_missing_credentials` warn is logged and registration is skipped (defence in depth — the primary invariant lives in `src/index.ts`).

`BuildServerDeps` gained one optional field: `credentials?: CredentialsStore`. Existing integration tests (readyz, healthz, webhook-flow) build the server without it — they now exercise the SETUP_ENABLED=false branch implicitly and stay green.

## index.ts boot delta (Task 2)

```
loadEnv
  → initLogger
  → initDefaultConfigLoader
  → if (env.SETUP_ENABLED):
      mkdirSync(SETUP_OUTPUT_DIR, recursive)
      checkStaleOnBoot(SETUP_OUTPUT_DIR, appLog)
      credentialsStore = createCredentialsStore({dir, log})
  → createProbot → … → buildServer({…, credentials: credentialsStore}) → app.listen()
```

`mkdirSync` precedes `checkStaleOnBoot` so first-boot does not crash on `ENOENT` from `statSync` (checkStaleOnBoot itself swallows ENOENT, but the directory still has to exist before createCredentialsStore tries to write into it). Shutdown is NOT modified — the credentials store has no `stop()`; its TTL `setTimeout` is `.unref()'d` per Plan 03, so it never blocks process exit.

## End-to-end test (Task 3) — `test/integration/setup-flow.test.ts`

Six `it` blocks driving every behaviour bullet:

1. **404 gate.** SETUP_ENABLED=false → GET `/setup/new`, `/setup/callback`, `/setup/credentials.env` all 404.
2. **CSRF state binding.** SETUP_ENABLED=true → GET `/setup/new` sets `auto_merge_setup_state` cookie; the value of that cookie equals the `state` field embedded in the rendered manifest JSON.
3. **Happy path.** Form → callback (with matching cookie+state) → conversion endpoint called exactly once → `credentials.env` exists on disk → success page contains `GitHub App создан` and the APP_ID → download cookie issued.
4. **Refresh idempotency.** A second GET `/setup/callback` with the same code+state re-renders from disk; `conversionCalls` counter stays at 1 (verifies Pitfall 1 mitigation — code is single-use, 1h TTL).
5. **Duplicate setup.** Pre-existing `credentials.env` (via `credentials.persist(…)` before server build) → `/setup/new` renders the warning page, no `name="manifest"` markup, no state cookie issued.
6. **Gated download.** With the download cookie attached, GET `/setup/credentials.env` returns `Content-Disposition: attachment; filename=credentials.env` and `rawPayload` byte-equal to `readFileSync(disk)`.

msw is set up with `onUnhandledRequest: "error"` so any accidental real network call would fail the test.

## Deviations from Plan

### Auto-fixed / Acceptance-criteria reconciliation

**1. [Note — not a code change] grep-counts in Task 2 acceptance criteria**
- **Found during:** Task 2 verification
- **Issue:** Plan asserted `grep -c 'checkStaleOnBoot' src/index.ts → 1` and same for `createCredentialsStore` / `mkdirSync`. With named imports the actual counts are 2 each (import + call site).
- **Resolution:** kept the natural named-import style (matches project conventions in `src/index.ts`); behaviour (exactly one call site of each, properly ordered) is correct. tsc clean. Boot order verified: line 21 `initDefaultConfigLoader` → lines 32-37 `SETUP_ENABLED` block → line ~108 `app.listen`.
- **Files modified:** none (acceptance interpreted by intent).

No other deviations — composition mirrors what Plans 04/05 expected, and the e2e test passed on first run.

## Auth gates

None. The conversion endpoint `POST /app-manifests/{code}/conversions` is anonymous by design (D-20) and msw intercepts it before any real network reach.

## Verification

- `npx vitest run test/integration/setup-flow.test.ts` — 6/6 green.
- `npx vitest run` — full suite 522/522 green (was 516 before, +6 new).
- `npx tsc --noEmit` — 0 errors.
- `grep -c 'SETUP_ENABLED' src/server.ts` → 1 (the gate).
- `grep -c 'SETUP_ENABLED' src/index.ts` → 1 (the boot guard).
- `grep -c 'registerSetupRoutes' src/setup/routes.ts` → 1 (export).
- `git diff` on `src/server.ts` shows only additive changes — no edits inside the existing webhook gate.

## Threat-model status

| Threat | Mitigation status |
|---|---|
| T-08-26 (routes exposed in prod) | mitigated — SETUP_ENABLED gate verified by 404-case test |
| T-08-27 (stale credentials.env survives restart) | mitigated — `checkStaleOnBoot` wired before `app.listen()` |
| T-08-28 (flag true but store missing) | mitigated — boot-layer invariant + server.ts defence-in-depth warn |
| T-08-29 (cross-test contamination) | mitigated — per-test `mkdtemp` + `rm` cleanup |

## Phase-9 handoff note

After this plan: `credentials.env` is the ONLY persisted setup artifact. Phase 9 (onboarding webhook) can assume the file exists at `env.SETUP_OUTPUT_DIR/credentials.env` after a completed setup, and that its lifetime is bounded by either (a) TTL `unref()'d` setTimeout or (b) boot-time stale cleanup, whichever fires first.

## Known stubs

None.

## Threat flags

None — no new network endpoints or trust boundaries beyond those scoped in `08-CONTEXT.md`.

## Self-Check: PASSED

- `src/setup/routes.ts` — FOUND
- `src/server.ts` — FOUND (modified)
- `src/index.ts` — FOUND (modified)
- `test/integration/setup-flow.test.ts` — FOUND
- Commit `3ebf39b` (Task 1) — FOUND
- Commit `0f73eb8` (Task 2) — FOUND
- Commit `742891e` (Task 3) — FOUND
