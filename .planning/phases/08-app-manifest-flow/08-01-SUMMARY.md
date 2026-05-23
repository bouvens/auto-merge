---
phase: 08-app-manifest-flow
plan: 01
subsystem: foundation
tags: [env, log, auth, setup]
requires: [phase-06, phase-07]
provides:
  - "Env.SETUP_APP_NAME (string, default 'auto-merge')"
  - "Env.SETUP_OUTPUT_DIR (string, default './data')"
  - "REDACT_PATHS pairs: pem, client_secret, webhook_secret, state (root + wildcard)"
  - "getAnonymousOctokit() export from src/auth.ts"
affects: [src/env.ts, src/log.ts, src/auth.ts]
tech-stack:
  added: []
  patterns: [TDD-RED-GREEN, additive-env-staging]
key-files:
  created:
    - test/unit/auth-anonymous.test.ts
  modified:
    - src/env.ts
    - src/log.ts
    - src/auth.ts
    - test/unit/env.test.ts
    - test/unit/log-redact.test.ts
    - test/unit/auth-app-octokit.test.ts
    - test/unit/auth-bot-identity.test.ts
    - test/unit/auth-readyz.test.ts
    - test/integration/dispatch-webhook.test.ts
    - test/integration/healthz.test.ts
    - test/integration/push-webhook.test.ts
    - test/integration/readyz-notify-status.test.ts
    - test/integration/readyz.test.ts
    - test/integration/webhook-flow.test.ts
decisions:
  - "SETUP_APP_NAME/SETUP_OUTPUT_DIR resolve unconditionally (no superRefine) so stale-credentials check can read them regardless of SETUP_ENABLED (D-01, D-04)."
  - "getAnonymousOctokit() is intentionally auth-free — POST /app-manifests/{code}/conversions is unauthenticated and returns the credentials itself (D-20)."
metrics:
  duration: "~10 min"
  completed: 2026-05-23
---

# Phase 08 Plan 01: Wave-1 foundations (env + log + auth) Summary

Wave-1 additive foundations for Phase 8 manifest flow: two new env fields, four new pino redact pairs, and an anonymous Octokit factory — all consumed by downstream plans 02-06.

## Files touched

| File | Δ lines | Change |
|------|---------|--------|
| `src/env.ts` | +3 | `SETUP_APP_NAME` (min 1, max 34, default `auto-merge`), `SETUP_OUTPUT_DIR` (default `./data`) added to `Base` zod object next to existing `SETUP_*` fields. |
| `src/log.ts` | +10 | Appended 4 secret-name pairs (root + wildcard) to `REDACT_PATHS`: `pem`, `client_secret`, `webhook_secret`, `state`. |
| `src/auth.ts` | +5 | New `getAnonymousOctokit()` export — `new Octokit()` with no auth strategy; placed between `getAppOctokit` and `getInstallationOctokit`. |
| `test/unit/env.test.ts` | +49 | New describe block "Phase 8 app-manifest setup env fields (D-01, D-11)" — 6 cases: defaults, overrides, empty-rejected, length-35 rejected, length-34 accepted, regression for existing `SETUP_ENABLED → SETUP_PUBLIC_URL` superRefine. |
| `test/unit/log-redact.test.ts` | +57 | New describe block "Phase 8 setup-credential redactions" — 6 cases covering each new pair at both root and nested depth. |
| `test/unit/auth-anonymous.test.ts` | +29 (new) | 3 cases: instance type, fresh-per-call, no-throw without `createProbot()`. |

Test-helper backfill (Rule 3, blocking tsc fix):

| Helper file | Δ lines |
|-------------|---------|
| `test/unit/auth-app-octokit.test.ts`, `auth-bot-identity.test.ts`, `auth-readyz.test.ts` | +3 each |
| `test/integration/dispatch-webhook.test.ts`, `healthz.test.ts`, `push-webhook.test.ts`, `readyz-notify-status.test.ts`, `readyz.test.ts`, `webhook-flow.test.ts` | +3 each |

Each helper's `Env` literal gained `SETUP_APP_NAME: "auto-merge"`, `SETUP_OUTPUT_DIR: "./data"`, `DEFAULT_CONFIG_RELOAD_MS: 60_000`. `DEFAULT_CONFIG_RELOAD_MS` was already a required `Env` field as of Phase 7 but the helpers had never been updated — surfaced now that another required field made tsc fail loudly across them.

## Test count delta

- Before: 401 tests across 47 files.
- After: 414 tests across 48 files.
- Δ = +13 tests, +1 file (`auth-anonymous.test.ts`).

## Verification

| Check | Result |
|-------|--------|
| `npx vitest run test/unit/env.test.ts test/unit/log-redact.test.ts test/unit/auth-anonymous.test.ts` | 57/57 pass |
| `npx vitest run` (full suite) | 414/414 pass |
| `npx tsc --noEmit` | 0 errors |
| `grep -c 'SETUP_APP_NAME' src/env.ts` | 1 |
| `grep -c 'getAnonymousOctokit' src/auth.ts` | 1 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Backfilled `Env` literals across 9 test helpers**
- **Found during:** Task 1 verify (`npx tsc --noEmit` after adding two new `Env` fields).
- **Issue:** 9 test files constructed `Env`-shaped literals inline; adding `SETUP_APP_NAME`/`SETUP_OUTPUT_DIR` made every one of them a TS2345 error. `DEFAULT_CONFIG_RELOAD_MS` was also missing from the same literals (pre-existing Phase-7 gap that tsc had been quietly accepting because the literal was assigned positionally elsewhere).
- **Fix:** Added the three fields with their defaults to every helper. No runtime behaviour change — these literals are only used to satisfy the `Env` type when invoking `createProbot` / readiness probes in tests.
- **Files modified:** 3 unit + 6 integration test files (see table above).
- **Commit:** `c6041f0`.

### Auth gates

None.

## Threat Flags

None — additive foundations only; no new trust boundary introduced. `getAnonymousOctokit` egress is in the existing threat register (T-08-04, disposition `accept`).

## Downstream Note

Plans 02-06 of phase 08 can now `import { getAnonymousOctokit } from "../auth.js"`, read `env.SETUP_APP_NAME` / `env.SETUP_OUTPUT_DIR` from the already-validated `Env` instance, and log credential payloads (`pem`, `client_secret`, `webhook_secret`, `state`) without leaking — every new secret name is masked at both root and `*.x` depth.

## Self-Check: PASSED

- [x] `src/env.ts` contains `SETUP_APP_NAME` (verified).
- [x] `src/log.ts` contains `"pem"`, `"client_secret"`, `"webhook_secret"`, `"state"` (verified).
- [x] `src/auth.ts` contains `export function getAnonymousOctokit` (verified).
- [x] `test/unit/auth-anonymous.test.ts` exists (verified).
- [x] Commits `c17d0da` (RED env), `31891be` (GREEN env), `1a562e1` (RED log), `8419c46` (GREEN log), `c9c6d40` (RED auth), `1663496` (GREEN auth), `c6041f0` (helper backfill) — all present in `git log`.
