# Deferred Items — Phase 09

## Out-of-scope discoveries

### TS2352 in test/unit/onboarding-onboardRepo.test.ts (lines 74, 125)

Discovered during Plan 09-07 typecheck. Pre-existing from Plan 09-05 commits b771d4b / eb97583. Two `as { request: { mock: ... } }` casts on `Octokit` need to go via `unknown` (TS strict cast rule) or use `vi.mocked()` helper.

Not in scope for 09-07 (which only touches `src/notify/dispatcher.ts` + a new test file). Surface for Plan 09-05 follow-up or verifier sweep.
