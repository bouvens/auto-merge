---
phase: 02-cascade-engine
plan: 03
subsystem: cascade
tags: [dedup, lru, trigger, ttl]
requires: [lru-cache v11 (added in Phase 1)]
provides:
  - "sourceShaDedup singleton: { seen(key), mark(key) }"
  - "10-min TTL, max 5000 entries, key shape \\`${owner}/${repo}@${sha}\\`"
affects: []
tech-stack:
  added: []
  patterns: ["LRU+TTL singleton (twin of src/webhook/dedup.ts)"]
key-files:
  created:
    - src/cascade/sourceShaDedup.ts
    - test/unit/cascade-source-sha-dedup.test.ts
  modified: []
decisions:
  - "Three deltas vs src/webhook/dedup.ts: max=5_000, export name sourceShaDedup, key shape \\`${owner}/${repo}@${sha}\\` (caller-enforced)."
  - "Comment policy hook collapsed the planned 2-line comment header into one WHY-line containing both the D-18/TRIG-04 reference and the thunk-perf / ttlResolution / ttlAutopurge rationale."
metrics:
  duration: ~3 min
  tasks: 1
  files: 2
  completed: 2026-05-21
---

# Phase 02 Plan 03: source-sha dedup LRU — Summary

Added `sourceShaDedup`, a process-singleton LRU keyed by `(owner, repo, source_sha)`, as a structural twin of `src/webhook/dedup.ts`. Catches logical re-triggers across `delivery_id`s (UI retries, future cron tick, future `repository_dispatch`) per D-18 / TRIG-04. Pure data module — no orchestrator coupling yet.

## What Was Built

### `src/cascade/sourceShaDedup.ts`

Three deltas vs the Phase 1 delivery-id dedup:

1. `max: 5_000` (lower than delivery-id's 10_000 — fewer distinct SHAs per 10-min window than delivery IDs).
2. Exported name `sourceShaDedup`.
3. Key shape `${owner}/${repo}@${sha}` (convention, computed by callers; module is a string key/value store).

Everything else byte-equivalent: `LRUCache` constructor, `ttl: 10 * 60 * 1000`, `ttlResolution: 0`, `ttlAutopurge: true`, `perf: { now: () => Date.now() }` (thunk for fake-timer compatibility).

### `test/unit/cascade-source-sha-dedup.test.ts`

Six tests under `vi.useFakeTimers({ toFake: ["Date", "performance"] })`:

1. seen returns false before mark.
2. seen returns true immediately after mark.
3. seen returns false for an unrelated key (different SHA or different owner/repo).
4. TTL: advance 10min+1ms → seen returns false.
5. TTL boundary: advance exactly 10min-1ms → seen still returns true.
6. LRU capacity: mark 5001 distinct keys → key index 0 evicted, key index 5000 retained.

Globally-unique key strings used per-test (per plan guidance) so module-level singleton state does not leak between `it` blocks.

## Verification

- `npm test -- test/unit/cascade-source-sha-dedup.test.ts` — 6/6 pass.
- `npm run typecheck` — clean.
- `npm run lint` — no findings in `src/cascade/**` or the new test. Pre-existing findings in `src/config/loader.ts`, `src/auth.ts`, `test/unit/log-redact.test.ts`, `test/unit/config-loader-parse.test.ts`, `test/integration/check-run-on-invalid.test.ts` are unrelated to this plan and out of scope.

## Commits

- `f7a24b1` test(02-03): add failing tests for sourceShaDedup LRU (RED)
- `6129a7e` feat(02-03): add sourceShaDedup LRU cache for source-sha re-trigger dedup (GREEN)

No REFACTOR commit — file is intentionally a minimal copy of its twin; no cleanup needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Comment-policy hook collapsed the 2-line header**
- **Found during:** Task 1 GREEN phase.
- **Issue:** Plan instructed prepending one `//` line above the existing two-line WHY-comment in `src/webhook/dedup.ts`. The repo-wide `comment-blocker.sh` PreToolUse hook rejects ≥2 consecutive `//` lines.
- **Fix:** Merged the new D-18 / TRIG-04 sentence and the existing thunk-perf / ttlResolution / ttlAutopurge sentence into a single multi-clause WHY-line (one `//` line total). Information content preserved; line count -1 vs the twin file.
- **Files modified:** `src/cascade/sourceShaDedup.ts` only.
- **Commit:** `6129a7e`.
- **Note:** This means the structural-diff sanity check in `<done>` will show one extra delta beyond the documented three (the comment header is one line shorter, not the same line-count-with-prepended-line as the plan specified). Functional code is byte-identical to the twin except for the three planned deltas (`max`, export name, header comment).

No Rule 1 / Rule 2 / Rule 4 deviations.

## TDD Gate Compliance

- RED commit `f7a24b1` (test only, verified failing before GREEN).
- GREEN commit `6129a7e` (implementation, all 6 tests pass).
- REFACTOR: skipped (file is a minimal twin — no cleanup target).

## Known Stubs

None. Module is functional and tested. The next plan (orchestrator wiring) will compute the `${owner}/${repo}@${sha}` key and call `seen` / `mark` at the appropriate point in the cascade entry path.

## Self-Check: PASSED

- `src/cascade/sourceShaDedup.ts` — FOUND.
- `test/unit/cascade-source-sha-dedup.test.ts` — FOUND.
- Commit `f7a24b1` — FOUND.
- Commit `6129a7e` — FOUND.
- All 6 tests pass; typecheck clean.
