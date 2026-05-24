---
phase: 10-diagnose-endpoint
plan: 05
subsystem: diagnose
tags: [diagnose, integration-test, msw, fastify, sc-coverage]

requires:
  - 10-01 (rateLimit + redact primitives)
  - 10-02 (runProbes + DiagnoseChecks/Report types)
  - 10-03 (renderMarkdown)
  - 10-04 (registerDiagnoseRoute + server.ts wiring)
provides:
  - test/integration/diagnose-endpoint.test.ts — end-to-end coverage of Phase 10 SC1-SC4
affects:
  - None (test-only addition)

tech-stack:
  added: []
  patterns:
    - "msw + buildServer + app.inject pattern (mirrors onboarding-bulk-install / setup-flow integration tests)"
    - "Unauthenticated Octokit + msw HTTP interception — sidesteps real JWT signing; tests the wired stack at the network boundary"
    - "Fresh app per test (no shared beforeAll) — keeps the per-server rate-limit singleton isolated between scenarios"

key-files:
  created:
    - test/integration/diagnose-endpoint.test.ts
  modified: []

key-decisions:
  - "Use unauthenticated `new Octokit()` instead of real `createProbot(env)` — msw intercepts at HTTP layer and ignores Authorization headers, so JWT signing is irrelevant; keeps the test free of real auth state and parallel-safe"
  - "Per-test `boot()` (no shared app instance) — the rate-limit singleton lives at registration time per server, so SC3 needs a clean instance; per-test boot is the simplest invariant rather than reset hooks on the rate-limit factory"
  - "String-contains redaction assertion on raw body — most resilient to future shape changes; any refactor that accidentally inlines a token segment fails fast (T-10-17)"
  - "Stubbed `healthChecker` returning ok/ok — avoids second msw harness for Slack/Telegram probes; the notify channel itself is covered by Phase 6's healthCheck test suite"
  - "Branches stubbed as exists=true, protected=false → branches.status='warn' but ok=true — exercises the warn-does-not-flip-ok invariant which is otherwise easy to regress on"

requirements-completed: [DIAG-01, DIAG-02, DIAG-03, DIAG-04]

duration: ~5min
completed: 2026-05-24
---

# Phase 10 Plan 05: End-to-end /diagnose integration test Summary

**Single integration test file (`test/integration/diagnose-endpoint.test.ts`) covering Phase 10 ROADMAP Success Criteria 1-4 end-to-end via msw + buildServer + app.inject — proves the seams between server.ts, handler.ts, probes.ts, and markdown.ts hold together against stubbed GitHub endpoints.**

## Performance

- **Duration:** ~5 min
- **Tasks:** 1 (single integration test file)
- **Files created:** 1 (`test/integration/diagnose-endpoint.test.ts`)
- **Files modified:** 0
- **Tests added:** 9 (was 665 → 674)

## Accomplishments

- **SC1 — JSON envelope + content negotiation.** Happy-path msw fixtures (installation + repo + app/installations/{id} + contents/.github%2Fauto-merge.yml + pulls + branches/main|dev with 404-protection) drive a single `GET /diagnose/testowner/testrepo` through the wired stack. Asserts exact response envelope keys (`ok, owner, repo, checked_at, checks`), exact `checks` key-set (all 6 sections), and per-section status. A second scenario asserts `Accept: text/markdown` → `text/markdown; charset=utf-8` response starting with `# Diagnose: testowner/testrepo`.
- **SC2 — auth gates.** Three scenarios:
  - `DIAGNOSE_TOKEN` unset → 503 `{error: "diagnose-disabled"}` even with a valid bearer header (proves the 503 gate fires before auth).
  - Missing `Authorization` header → 401.
  - Equal-length wrong token → 401 (timing-safe path).
  - Length-mismatched wrong token → 401 (dummy-compare branch executes safely).
- **SC3 — rate-limit.** 10 sequential `app.inject` calls with valid bearer → all 200; 11th call → 429 with numeric `Retry-After > 0`. Exercises the singleton rate-limit constructed at `registerDiagnoseRoute` time against the real `lru-cache` factory.
- **SC4 — redaction.** Env has `SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T1/B1/SECRET_TOKEN_SEGMENT_XYZ` and `TELEGRAM_BOT_TOKEN=1234567890:AAA_SECRET_BOT_TOKEN_VALUE_AAAAAAAAAA`. Asserts via `expect(res.body).not.toContain(...)` that neither secret substring nor the literal `DIAGNOSE_TOKEN` value appears in the JSON body. String-contains on the raw body is the most resilient assertion against any future refactor that might accidentally inline a token.
- **Regression — full key-set on early-exit.** Override msw to 404 on `GET /repos/{o}/{r}/installation` → 200 with `body.checks.app_installed.status === "error"`, `detail === "app-not-installed"`, and all other check sections present with `status: "n/a"`. Proves the SC1 envelope invariant holds even when Step A short-circuits.

## Task Commits

1. **Task 1 (integration test)** — `825ec46` `test(10-05): integration coverage of /diagnose endpoint SC1-SC4`

(Plan 10-05 is a single-task plan delivering pure integration coverage; no RED/GREEN split is meaningful because the implementation under test was shipped in 10-04. The test itself is the deliverable.)

## Decisions Made

- **Unauthenticated Octokit instead of real createProbot.** Real auth would mean generating an RSA keypair per test, calling `createProbot(env)` to mint the App JWT, then minting an installation token. msw intercepts at the HTTP layer and ignores the `Authorization` header — using `new Octokit()` avoids the entire JWT path. The auth path itself is already covered by `src/auth.test.ts` and `src/diagnose/handler.test.ts`.
- **Fresh `app` per test (no `beforeAll`).** The rate-limit singleton lives at registration time, so a shared `app` would let SC1 scenarios consume budget that SC3 expects to start from zero. Per-test `boot()` is the simplest invariant; alternatives (resetting the rate-limit via an exposed reset hook, or relying on `vi.useFakeTimers()` to roll the TTL window) would couple the test to internal implementation details.
- **Stubbed `healthChecker` (ok/ok).** The notify channel itself is covered by Phase 6's healthCheck integration suite. Re-stubbing Slack/Telegram via a second msw harness here would duplicate Phase 6 coverage without adding signal for Phase 10's contract.
- **`branches.status === "warn"` assertion in SC1.** Branches stubbed as `exists: true, protected: false` — branches.status correctly degrades to `warn` but the overall envelope keeps `ok: true`. This guards against the regression where any non-ok section flips overall ok (which would be wrong — only `error` flips ok per `computeOk`).

## Deviations from Plan

**None.** The plan specified 9 scenarios across 4 SCs; all 9 implemented as written. No Rule 1/2/3 fixes needed — the wired stack from Plan 10-04 worked first-pass against msw'd GitHub endpoints.

## Issues Encountered

- **Biome formatter run after first compile.** First write triggered biome's array-literal collapse rule (multi-line array → single-line when it fits). Auto-fixed via `npx biome check --write`. Not a deviation — formatter housekeeping.

## User Setup Required

None — pure test addition.

## Verification

- `npx vitest run test/integration/diagnose-endpoint.test.ts` → 9/9 pass
- `npx vitest run` → 674/674 pass (was 665 → +9 new; zero regressions)
- `npx biome check test/integration/diagnose-endpoint.test.ts` → clean

## Threat Surface

T-10-17 (mitigation strength for redaction regression) — satisfied. SC4 uses `expect(res.body).not.toContain(...)` on the raw response body for both Slack and Telegram secret segments plus the literal `DIAGNOSE_TOKEN` value; any future refactor that accidentally inlines a token into the JSON response (e.g., echoing env vars into a debug section, or serialising the full `NotifyHealthChecker` instance) fails this assertion immediately. T-10-16 (test-only fixtures) accepted — no production surface introduced.

No new surface beyond the plan's threat model.

## Known Stubs

None. The test stubs are deliberate test seams (`fakeHealthChecker`, unauthenticated `new Octokit()`, `buildHappyMsw()`) — none of them are production code paths.

## Self-Check: PASSED

- `test/integration/diagnose-endpoint.test.ts` — FOUND
- Commit `825ec46` — FOUND in git log
- Full suite green (674/674)
- `npx biome check test/integration/diagnose-endpoint.test.ts` → clean

## Next Phase Readiness

- DIAG-01 / DIAG-02 / DIAG-03 / DIAG-04 satisfied at the integration level (handler-unit coverage from 10-04 + this end-to-end coverage = full vertical).
- Phase 10 complete; ready for `/gsd-verify-phase 10`.
- Phase 11 (Release artifacts) is parallel-friendly — no `src/` dependency on Phase 10 outputs.
- No FROZEN v1.0 component touched; only one test file added.

---
*Phase: 10-diagnose-endpoint*
*Completed: 2026-05-24*
