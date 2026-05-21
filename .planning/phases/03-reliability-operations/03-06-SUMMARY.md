---
phase: 03-reliability-operations
plan: "06"
subsystem: dispatch
tags: [trig-03, repository_dispatch, probot, webhook, readme]
dependency_graph:
  requires: [03-01, 03-02, 03-04]
  provides: [TRIG-03]
  affects: [src/server.ts, src/dispatch/handler.ts, README.md]
tech_stack:
  added: []
  patterns:
    - probot.on('repository_dispatch') registered via registerDispatchHandler (mirrors registerPushHandler shape)
    - DispatchContext interface locally narrowed to only used fields
    - CascadeJob{source:'dispatch', after:null} — orchestrator resolves main HEAD post-dequeue
key_files:
  created:
    - src/dispatch/handler.ts
    - test/unit/dispatch-handler.test.ts
    - test/integration/dispatch-webhook.test.ts
  modified:
    - src/server.ts
    - README.md
decisions:
  - action !== 'auto-merge' silently skipped; D-09: other apps may share the repository_dispatch channel
  - No loop-prevention on dispatch path; D-10: sender is GITHUB_TOKEN workflow, not bot identity
  - No sourceShaDedup pre-enqueue; D-10: dedup runs post-SHA-resolve in orchestrator
  - payload.branch ignored; RESEARCH §3: GitHub-resolved default branch, not user-controllable
  - client_payload logged verbatim for audit; D-24: sanitization is operator responsibility
  - Bot-sender test uses distinct main-branch SHA to avoid sourceShaDedup suppressing the integration test run
metrics:
  duration: "~15 minutes"
  completed: "2026-05-21T17:04:43Z"
  tasks_completed: 5
  files_changed: 5
---

# Phase 3 Plan 06: repository_dispatch Handler (TRIG-03) Summary

Implemented `probot.on('repository_dispatch', ...)` handler accepting `event_type=auto-merge` and enqueuing a `CascadeJob{source:'dispatch'}`. Orchestrator resolves `main` HEAD post-dequeue, applies sourceShaDedup, and runs the same cascade pipeline as push. User-side workflow snippet documented in README with no-PAT auth path.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Implement src/dispatch/handler.ts | 981ca6d | src/dispatch/handler.ts |
| 2 | Unit tests for dispatch handler | f6309fd | test/unit/dispatch-handler.test.ts |
| 3 | Wire registerDispatchHandler into buildServer | ed78395 | src/server.ts |
| 4 | Integration tests: signed dispatch webhook → cascade | 2eeb65c | test/integration/dispatch-webhook.test.ts |
| 5 | README section for manual trigger via workflow_dispatch | 03f1ea3 | README.md |

## Verification

- `npx tsc --noEmit` — clean
- `npx vitest run` — 256 tests pass across 33 files (no regressions)
- 6 unit tests: action filter, missing installation, valid enqueue, bot-sender exemption, no-dedup, client_payload audit
- 3 integration tests: auto-merge → cascade runs; other action → no cascade; bot sender → cascade runs (D-10 proven end-to-end)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] sourceShaDedup cross-test contamination in integration test**
- **Found during:** Task 4 (bot-sender integration test)
- **Issue:** The sourceShaDedup singleton marked `acme/widgets@main-head-dispatch` after the first integration test; the third test (bot-sender) used the same main HEAD SHA and was suppressed by dedup in the orchestrator, causing `mergeCalls.length === 0`
- **Fix:** Added `harness.setBranchHead("main", "main-head-dispatch-bot")` in the bot-sender test to give it a unique SHA, bypassing the already-seen dedup entry
- **Files modified:** test/integration/dispatch-webhook.test.ts
- **Commit:** 2eeb65c

## Known Stubs

None — all dispatch routing is wired end-to-end through the existing orchestrator.

## Threat Flags

No new network surface introduced. The `/webhook` route already existed; `repository_dispatch` flows through the same HMAC-verified `verifyAndReceive` path. No new trust boundary.

## Self-Check: PASSED

- `src/dispatch/handler.ts` — exists ✓
- `test/unit/dispatch-handler.test.ts` — exists ✓
- `test/integration/dispatch-webhook.test.ts` — exists ✓
- Commits 981ca6d, f6309fd, ed78395, 2eeb65c, 03f1ea3 — all present in git log ✓
- All 256 vitest tests pass ✓
- `tsc --noEmit` clean ✓
