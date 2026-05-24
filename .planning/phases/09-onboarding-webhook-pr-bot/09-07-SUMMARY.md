---
phase: 09-onboarding-webhook-pr-bot
plan: 07
subsystem: notify
tags: [additive, dispatcher, suppression, onboarding]
requires:
  - 09-01 (suppressionSet — wiring deferred to 09-09)
provides:
  - "MultiChannelOptions.suppressionCheck — predicate to drop notify per installation_id"
  - "queue_overflow id extraction from key prefix"
affects:
  - src/notify/dispatcher.ts
tech-stack:
  added: []
  patterns:
    - "Additive ctor option (default = {}) — preserves v1.0 call sites"
    - "Predicate gating before fan-out — fail-open when id undefined"
key-files:
  created:
    - test/unit/notify-dispatcher.test.ts
    - .planning/phases/09-onboarding-webhook-pr-bot/deferred-items.md
  modified:
    - src/notify/dispatcher.ts
decisions:
  - "queue_overflow id parsed from key prefix `${id}/owner/repo`, NOT added as a new field — keeps channel.ts NotifyEvent union FROZEN (D-21)"
  - "Suppression branch logs `notify_suppressed_onboarding` at debug level for operator visibility (T-09-23 mitigation)"
  - "extractInstallationId returns undefined → no suppression (fail-open) preserves v1.0 'always notify' invariant when in doubt"
metrics:
  duration: ~8m
  tasks_completed: 2
  files_changed: 3
  completed: 2026-05-24
---

# Phase 09 Plan 07: MultiChannel suppressionCheck Summary

One-liner: Additive `suppressionCheck` ctor option on `MultiChannel` plus key-prefix installation_id extraction for `queue_overflow`, enabling onboarding noise suppression without touching the FROZEN `NotifyEvent` union.

## What Shipped

`src/notify/dispatcher.ts` — extended:
- New exported `interface MultiChannelOptions { suppressionCheck?: (installationId: number) => boolean }`.
- Constructor gains optional 2nd positional param `options: MultiChannelOptions = {}` — existing `new MultiChannel(channels)` callers unchanged.
- `notify(event)` now first calls module-private `extractInstallationId(event)`:
  - Events with `installation_id?: number` (cascade_conflict, protection_blocked, permission_error, config_invalid) → returns the field.
  - `queue_overflow` → parses `event.key.split("/")[0]` as integer; positive integer wins, otherwise undefined.
  - Other shapes → undefined.
- If id is defined AND `suppressionCheck(id) === true`: logs `log.debug({event: "notify_suppressed_onboarding", kind, installation_id})` and returns without touching channels.
- Otherwise: original `Promise.allSettled(this.channels.map((c) => c.notify(event)))` fan-out — unchanged.

`test/unit/notify-dispatcher.test.ts` — created with 11 tests:
1. Legacy ctor (no options) forwards.
2. Empty `{}` forwards.
3. `suppressionCheck: () => false` forwards.
4. `suppressionCheck(42)=true` + cascade_conflict installation_id=42 → suppressed; debug log emitted.
5. Same predicate + installation_id=99 → forwarded.
6. queue_overflow key `"42/acme/api"` + suppress(42) → suppressed.
7. queue_overflow key `"99/acme/api"` + suppress(42) → forwarded.
8. queue_overflow key `"no-slash-here"` + suppress(any) → forwarded (NaN guard).
9. queue_overflow key `"abc/acme/api"` + suppress(any) → forwarded (non-numeric prefix).
10. cascade_conflict without installation_id field + suppress(any) → forwarded (id undefined).
11. Multi-channel suppression — none of 3 stubs called.

## TDD Gates

- RED: commit `62e536c` (test/unit/notify-dispatcher.test.ts) — 3 suppression-path tests fail against unmodified dispatcher.
- GREEN: commit `94b73b7` (src/notify/dispatcher.ts) — all 11 tests pass; full suite 589/589 green.
- REFACTOR: none needed (33-line dispatcher already minimal).

## Frozen-Component Compliance

- `src/notify/channel.ts` — zero changes (`git diff --stat` empty). `NotifyEvent` union untouched.
- `src/notify/dispatcher.ts` — additive only: new ctor parameter has a default; new helper is module-private; existing fan-out line preserved verbatim (`grep -c "Promise.allSettled" == 1`).
- v1.0 call sites (e.g. `src/index.ts` if any exist today) continue to compile and behave identically.

## Deviations from Plan

None — plan executed exactly as written.

## Authentication Gates

None.

## Deferred Issues

Pre-existing TS2352 in `test/unit/onboarding-onboardRepo.test.ts` (lines 74, 125) — surfaced by typecheck but originated in Plan 09-05 commits. Logged in `.planning/phases/09-onboarding-webhook-pr-bot/deferred-items.md`. Out of scope for this plan.

## Known Stubs

None.

## Commits

- `62e536c` test(09-07): add failing tests for MultiChannel suppression gate
- `94b73b7` feat(09-07): additive suppressionCheck option on MultiChannel

## Verification Evidence

- `npm test -- test/unit/notify-dispatcher.test.ts` → 11/11 pass.
- `npm test` (full suite) → 589/589 pass across 61 files.
- `npm run typecheck` → `src/notify/dispatcher.ts` clean (only the pre-existing unrelated `onboarding-onboardRepo.test.ts` errors remain).
- `git diff --stat src/notify/channel.ts` → empty.
- `grep -c "Promise.allSettled" src/notify/dispatcher.ts` → 1.

## Wiring Pointer (next plan)

Plan 09-09 will wire the option at app boot:
```ts
const notify = new MultiChannel(channels, { suppressionCheck: (id) => isOnboarding(id) });
```
where `isOnboarding` comes from `src/onboarding/suppressionSet.ts` (Plan 09-01).

## Self-Check: PASSED

- `src/notify/dispatcher.ts` — FOUND (modified).
- `test/unit/notify-dispatcher.test.ts` — FOUND.
- Commit `62e536c` — FOUND.
- Commit `94b73b7` — FOUND.
- `src/notify/channel.ts` unchanged — VERIFIED.
