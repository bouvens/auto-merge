---
phase: 10-diagnose-endpoint
plan: 04
subsystem: diagnose
tags: [diagnose, fastify, route, bearer-auth, rate-limit, content-negotiation, trust-proxy]

requires:
  - 10-01 (rateLimit + redact primitives)
  - 10-02 (runProbes orchestrator + DiagnoseChecks/Report types)
  - 10-03 (renderMarkdown)
  - src/auth.ts (getInstallationOctokit, getAppOctokit)
  - src/notify/healthCheck.ts (NotifyHealthChecker)
provides:
  - registerDiagnoseRoute(app, deps) — Fastify GET /diagnose/:owner/:repo with 503-gate → rate-limit → bearer-auth pre-handler chain (D-07)
  - REQUIRED_PERMISSIONS constant — canonical App permission set (D-15)
  - compareBearer / parseBearer helpers — constant-time bearer compare with length-mismatch dummy
  - BuildServerDeps fields: healthChecker (mandatory), getAppOctokit, getInstallationOctokit
  - Fastify constructed with trustProxy:true (D-20) — req.ip respects X-Forwarded-For behind Caddy/k8s ingress
  - test/helpers/diagnose-deps.ts — diagnoseDepsStub typed no-op trio for non-diagnose integration tests
affects:
  - test/integration/{healthz,readyz,readyz-notify-status,setup-flow,webhook-flow,dispatch-webhook,push-webhook,onboarding-bulk-install}.test.ts (spread diagnoseDepsStub into buildServer call sites)
  - src/server.ts (added registerDiagnoseRoute call + trustProxy + 3 new mandatory deps)
  - src/index.ts (boot wiring passes healthChecker + getAppOctokit + getInstallationOctokit)

tech-stack:
  added: []
  patterns:
    - "registerXxxRoute(app, deps) per-feature module (mirrors setup/manifestForm.ts split)"
    - "Test seam pattern: rateLimit + runProbesFn injection on DiagnoseDeps for deterministic unit tests"
    - "Mandatory dep with central stub helper — test/helpers/diagnose-deps.ts unblocks callers that don't exercise diagnose path"

key-files:
  created:
    - src/diagnose/handler.ts
    - src/diagnose/handler.test.ts
    - test/helpers/diagnose-deps.ts
  modified:
    - src/server.ts
    - src/index.ts
    - test/integration/healthz.test.ts
    - test/integration/readyz.test.ts
    - test/integration/readyz-notify-status.test.ts
    - test/integration/setup-flow.test.ts
    - test/integration/webhook-flow.test.ts
    - test/integration/dispatch-webhook.test.ts
    - test/integration/push-webhook.test.ts
    - test/integration/onboarding-bulk-install.test.ts

key-decisions:
  - "Single async preHandler implements 503-gate → rate-limit → bearer-auth (D-07) — keeps pre-handler ordering explicit and auditable in one function"
  - "compareBearer / parseBearer exported as test seams (planner discretion per D-09) — unit-tested independently of the full route"
  - "diagnoseDepsStub helper added to satisfy mandatory deps for 8 pre-existing test files — alternative (making deps optional) would silently disable diagnose in production"
  - "Rate-limit singleton constructed at registration time; per-request would reset the per-IP window — defensive comment in handler"
  - "Content negotiation via simple accept.includes('text/markdown') per D-12 — full Accept parser would mean a new dep for two formats"

requirements-completed: [DIAG-01, DIAG-02, DIAG-03, DIAG-04]

duration: ~10min
completed: 2026-05-24
---

# Phase 10 Plan 04: Diagnose route handler + server wiring Summary

**Fastify GET /diagnose/:owner/:repo composing rateLimit + runProbes + renderMarkdown behind a 503-gate → rate-limit → bearer-auth pre-handler chain; full boot wiring through server.ts (trustProxy:true, three new mandatory deps) and index.ts.**

## Performance

- **Duration:** ~10 min
- **Tasks:** 2 (Task 1 TDD: RED + GREEN; Task 2 wiring)
- **Files created:** 3 (handler, handler.test, diagnoseDepsStub helper)
- **Files modified:** 10 (server.ts, index.ts, 8 integration tests)

## Accomplishments

- `registerDiagnoseRoute(app, deps)` — single Fastify GET route with explicit pre-handler chain honoring D-07 order (503 → 429 → 401 → 200).
- `REQUIRED_PERMISSIONS` constant (D-15) — canonical App-permission spec sourced from `PROJECT.md` Constraints; passed into `runProbes` as a typed dependency.
- `compareBearer` — `crypto.timingSafeEqual` on length-matched buffers; length-mismatch path runs a dummy `timingSafeEqual` against zero-buffers to keep wall-clock constant (D-09).
- `parseBearer` — case-insensitive `Bearer <token>` extraction with whitespace trim; rejects non-Bearer schemes and empty tokens.
- Content negotiation per D-12: `Accept: text/markdown` → markdown body; default → JSON. Always 200 for the success path (D-11).
- `src/server.ts`: Fastify now constructed with `trustProxy: true` (D-20); `BuildServerDeps` carries three new mandatory fields; `registerDiagnoseRoute` called unconditionally so endpoint shape is stable.
- `src/index.ts`: passes existing `healthChecker` + the two octokit factories into `buildServer`.
- `test/helpers/diagnose-deps.ts`: typed no-op trio (`healthChecker` always-`n/a`, dummy octokit factories) — spread into pre-existing test buildServer call sites to keep them green.
- 25 new unit tests in `handler.test.ts` exercise every D-10/DIAG-* invariant (503-gate, auth failure modes, rate-limit headers + 11th-hit denial via the real factory, content negotiation, ok=false derivation, secret-absence sanity).

## Task Commits

1. **Task 1 RED** — `b6a8fe1` `test(10-04): add failing tests for diagnose route handler`
2. **Task 1 GREEN** — `3213d6d` `feat(10-04): implement diagnose route handler with 503-gate, rate-limit, bearer-auth`
3. **Task 2 wiring** — `366622b` `feat(10-04): wire diagnose route into server.ts and index.ts with trustProxy`

## Decisions Made

- **Test-seam exports.** `compareBearer` and `parseBearer` are exported (per planner discretion in D-09) — allows direct unit coverage of the constant-time path and the header-shape rejection table without going through a full Fastify inject cycle.
- **Mandatory deps + stub helper.** D-18 requires `healthChecker` to be mandatory so the diagnose route always registers. Making it optional would silently disable the endpoint in production; instead, a tiny `diagnoseDepsStub` helper lets pre-existing tests opt into the new contract with a single spread. Trade-off accepted: 8 test files needed a one-line edit.
- **Rate-limit lifecycle.** The singleton lives at registration time (one per server instance), not per-request — otherwise the per-IP window would reset on every call. Captured with a WHY-comment in `registerDiagnoseRoute`.
- **Accept parser scope.** `String(req.headers.accept ?? '').includes('text/markdown')` per D-12 — adding `@fastify/accepts` for two formats fails the project's "no speculative deps" rule (see PROJECT.md tech stack).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Updated 8 pre-existing test files to spread `diagnoseDepsStub`**
- **Found during:** Task 2 verification (full vitest suite after server.ts edits)
- **Issue:** Making `healthChecker`, `getAppOctokit`, `getInstallationOctokit` mandatory on `BuildServerDeps` (per D-18) broke every existing `buildServer({...})` call in integration tests — 23 failing tests across 8 files. The plan called out the dep change but did not enumerate the test-side fix.
- **Fix:** Added `test/helpers/diagnose-deps.ts` exporting a typed no-op trio; spread `...diagnoseDepsStub` into each `buildServer` call in: `healthz`, `readyz`, `readyz-notify-status`, `setup-flow`, `webhook-flow`, `dispatch-webhook`, `push-webhook`, `onboarding-bulk-install`. No semantic change — the stub returns `n/a` statuses and dummy octokits; none of those tests hit the diagnose route.
- **Files modified:** `test/helpers/diagnose-deps.ts` (new), 8 integration test files (one-line spread each).
- **Commit:** `366622b` (Task 2).
- **Verification:** 665/665 tests green; new diagnose path covered by handler.test.ts (25 tests); zero regressions in pre-existing suites.

**2. [Rule 1 — Bug] Tightened `computeOk` parameter type**
- **Found during:** Task 1 GREEN (tsc step)
- **Issue:** Initial draft typed the parameter as `Record<string, { status: ProbeStatus }>` for genericity; `tsc --noEmit` rejected passing `DiagnoseChecks` because the interface lacks an index signature.
- **Fix:** Narrowed the parameter to `DiagnoseChecks` directly — `Object.values` still works (every field exposes `status: ProbeStatus` per the contract in `types.ts`); inline WHY-comment notes the dependency on the type contract.
- **Files modified:** `src/diagnose/handler.ts`
- **Commit:** `3213d6d` (Task 1 GREEN).

---

**Total deviations:** 2 auto-fixed (1 blocking — test wiring after mandatory-dep change; 1 bug — tsc narrowing).
**Impact on plan:** Both are mechanical follow-ups to plan-mandated architecture (D-18 mandatory deps + `DiagnoseChecks` index-signature gap). No scope change.

## Issues Encountered

None beyond the two deviations above. Full suite (`npx vitest run`) is 665/665 green; `tsc --noEmit -p tsconfig.build.json` clean; `biome check` clean on all touched files.

## User Setup Required

None — plan is pure code + tests. The endpoint is operator-reachable in any environment that boots `src/index.ts` and has `DIAGNOSE_TOKEN` set; absent the token the route returns `503 {error:"diagnose-disabled"}` as designed (D-07).

## Verification

- `npx vitest run` → 665/665 pass (was 640 — adds 25 new handler unit tests; no regressions)
- `npx vitest run src/diagnose/handler.test.ts` → 25/25 pass
- `npx tsc --noEmit -p tsconfig.build.json` → clean
- `npx biome check src/diagnose/ src/server.ts src/index.ts test/helpers/diagnose-deps.ts` → clean
- `grep -c 'trustProxy: true' src/server.ts` → 1 (D-20 satisfied)
- `grep -c 'registerDiagnoseRoute' src/server.ts` → 2 (import + call site)

## Threat Surface

All threats in the plan's STRIDE register (T-10-10 … T-10-15) are mitigated as designed:

- **T-10-10 (Spoofing — bearer):** mitigated via `crypto.timingSafeEqual` on length-matched buffers + length-mismatch dummy compare; unit-tested in handler.test.ts (`equal-length wrong token` + `length-mismatched wrong token`).
- **T-10-11 (Repudiation — auth bypass via missing token):** mitigated by 503-gate running first in the pre-handler; unit-tested (`503-gate fires BEFORE rate-limit`).
- **T-10-12 (DoS via spoofed X-Forwarded-For):** accepted per plan — deployment behind Caddy/k8s strips/sets the header; documented as a README concern for Phase 11.
- **T-10-13 (Info disclosure — response redaction):** mitigated — notify section reads `healthChecker.getStatus()` enum; sanity test asserts the literal `DIAGNOSE_TOKEN` value never appears in any response body.
- **T-10-14 (Tampering — owner/repo to Octokit URL):** mitigated — Octokit URL-encodes path params; safeProbe wraps every call; no shell-out.
- **T-10-15 (EoP — diagnose as anonymous info-disclosure):** mitigated — bearer required by DIAG-02; 503 when token unset; per-IP rate-limit caps throughput.

No new surface beyond the plan's threat model.

## Known Stubs

None. `diagnoseDepsStub` in `test/helpers/` is a typed no-op intentionally — production wiring in `src/index.ts` passes the real `healthChecker`, `getAppOctokit`, and `getInstallationOctokit`. Integration coverage of the live wiring is the scope of Plan 10-05.

## Self-Check: PASSED

- `src/diagnose/handler.ts` — FOUND
- `src/diagnose/handler.test.ts` — FOUND
- `test/helpers/diagnose-deps.ts` — FOUND
- Commit `b6a8fe1` — FOUND in git log
- Commit `3213d6d` — FOUND in git log
- Commit `366622b` — FOUND in git log
- `grep -c 'trustProxy: true' src/server.ts` → 1 (expected: 1)
- `grep -c 'registerDiagnoseRoute' src/server.ts` → 2 (expected: 2)
- Full suite green (665/665)

## Next Phase Readiness

- DIAG-01 / DIAG-02 / DIAG-03 / DIAG-04 satisfied at the handler-unit level.
- Plan 10-05 (integration coverage) can `app.inject` against the wired `buildServer` to exercise the end-to-end JSON + markdown contract with real `runProbes` + msw'd GitHub endpoints — no further changes to handler.ts expected.
- No FROZEN v1.0 component modified. Boot-time `healthChecker.refresh()` still runs in `src/index.ts` after listen; first diagnose request will read the cached value.

---
*Phase: 10-diagnose-endpoint*
*Completed: 2026-05-24*
