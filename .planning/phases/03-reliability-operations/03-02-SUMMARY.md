---
phase: 03-reliability-operations
plan: "02"
subsystem: queue
tags: [multi-queue, per-repo-fifo, cascade-job, composition-root]
dependency_graph:
  requires: [03-01]
  provides: [MultiQueue<CascadeJob>, buildKey, CascadeJob union, PushJob alias]
  affects: [src/webhook/multiQueue.ts, src/cascade/orchestrator.ts, src/webhook/pushHandler.ts, src/server.ts, src/index.ts]
tech_stack:
  added: []
  patterns: [Map<key, {buf,running}> keyed queue, per-call drain tuple, microtask-deferred runLane, drop-oldest with notify]
key_files:
  created:
    - src/webhook/multiQueue.ts
    - test/unit/multi-queue.test.ts
  modified:
    - src/cascade/orchestrator.ts
    - src/webhook/pushHandler.ts
    - src/server.ts
    - src/index.ts
    - test/unit/cascade-orchestrator.test.ts
    - test/unit/push-handler.test.ts
    - test/integration/cascade-flow.test.ts
    - test/integration/push-webhook.test.ts
    - test/integration/webhook-flow.test.ts
decisions:
  - "Global cap drops from the largest lane (not from the enqueue target) to defend against fan-out across many repos"
  - "Per-call drain tuple {resolve, timer} ensures independent timeouts when drain() is called concurrently"
  - "GC deletion and size-check are synchronous tail of runLane — no async gap exists for enqueue to interleave"
  - "cron/dispatch branches in runCascade are cascade_skipped_unwired stubs; full handling lands in 03-04"
  - "PushJob = Extract<CascadeJob, {source:'push'}> preserves all existing Phase 2 imports without breaking changes"
metrics:
  duration: "~9 minutes"
  completed: "2026-05-21"
  tasks: 3
  files: 9
---

# Phase 3 Plan 02: MultiQueue + CascadeJob Wiring Summary

Per-repo FIFO serialization via `MultiQueue<CascadeJob>` replaces the single-key `Queue<PushJob>`, with idle lane GC, global + per-key drop-oldest overflow, and drain timeout isolation.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1+2 | Implement MultiQueue + unit tests | 0b43a99 | src/webhook/multiQueue.ts, test/unit/multi-queue.test.ts |
| 3 | Extend CascadeJob union + wire composition root | 6948931 | src/cascade/orchestrator.ts, src/webhook/pushHandler.ts, src/server.ts, src/index.ts |

## What Was Built

**`src/webhook/multiQueue.ts` (new)**
- `createMultiQueue<T>({perKeyMax, globalMax, handler, notify})` — Map of per-key `{buf, running}` lanes
- Per-key overflow: drop-oldest from the target lane + `log.warn(multi_queue_overflow)` + `notify.notify({kind:'queue_overflow'})`
- Global overflow: drop-oldest from the largest lane (fan-out defense per D-02)
- Idle lane GC: synchronous tail of `runLane` deletes empty lane and resolves all pending drain calls when `lanes.size === 0`
- `drain(timeoutMs)`: per-call `{resolve, timer}` tuple — concurrent drain calls have independent timeouts; on timeout logs `multi_queue_drain_timeout` with `remaining_keys`
- `buildKey({installation_id, owner, repo})` returns `${id}/${owner}/${repo}` per D-01

**`src/cascade/orchestrator.ts` (modified)**
- `PushJob` interface replaced by `CascadeJob` discriminated union (`source: 'push'|'cron'|'dispatch'`)
- `PushJob = Extract<CascadeJob, {source:'push'}>` alias preserves all Phase 2 imports
- `runCascade` is now `Handler<CascadeJob>`; cron/dispatch emit `cascade_skipped_unwired` until 03-04

**`src/webhook/pushHandler.ts` (modified)**
- Adds `source: 'push'` to job object literal
- `deps.queue.enqueue(buildKey(job), {id, payload:job})` — keyed by installation+owner+repo

**`src/server.ts` (modified)**
- `BuildServerDeps.queue` broadened from `Queue<PushJob>` to `MultiQueue<CascadeJob>`

**`src/index.ts` (modified)**
- `createQueue<PushJob>` replaced by `createMultiQueue<CascadeJob>({perKeyMax, globalMax, handler:runCascade, notify:new NoopChannel()})`

## Test Coverage

7 new unit tests in `test/unit/multi-queue.test.ts`:
1. Per-key FIFO serialization (release out-of-order, assert in-key ordering preserved)
2. Cross-key parallelism (peak inflight === 2)
3. Per-key drop-oldest + notify spy assertion
4. Global cap drops from largest lane + notify spy assertion
5. Idle lane GC and recreation (keyCount 0 → 1 after re-enqueue)
6. Drain global timeout (resolves after timeoutMs, logs multi_queue_drain_timeout)
7. Concurrent drain isolation (drain(50) and drain(100) each resolve at their own timeout)

All 223 tests pass (216 pre-existing + 7 new).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test files used old Queue<PushJob> interface after MultiQueue migration**
- **Found during:** Task 3 typecheck
- **Issue:** `test/unit/push-handler.test.ts`, `test/integration/push-webhook.test.ts`, `test/integration/webhook-flow.test.ts`, `test/integration/cascade-flow.test.ts`, `test/unit/cascade-orchestrator.test.ts` all used `Queue<PushJob>` mocks/factories and job objects without `source:'push'` after the interface changed
- **Fix:** Updated all affected test files to use `MultiQueue<CascadeJob>` fakes with `keyCount()` method; added `source:'push'` to all job factories
- **Files modified:** 5 test files
- **Commit:** 6948931

## Threat Model Coverage

| Threat | Status |
|--------|--------|
| T-03-05 DoS via fan-out | Mitigated: global cap enforced as sum across all lanes; per-key cap WEBHOOK_QUEUE_PER_KEY_MAX (default 16) |
| T-03-06 GC-vs-enqueue race | Mitigated: documented in code comment; Test 5 asserts lane re-creation; synchronous tail closes window |
| T-03-07 Repeat push spam | Accepted: per-key drop-oldest limits queue depth; sourceShaDedup (Phase 2) deduplicates at enqueue time |
| T-03-08 Silent dropped jobs | Mitigated: log.warn multi_queue_overflow with dropped_id + key; notify.notify stub called (Phase 4 delivers to Slack/Telegram) |

## Known Stubs

- `runCascade` cron/dispatch branches: emit `cascade_skipped_unwired` and return. Plan 03-04 replaces with lazy SHA resolution.
- `NoopChannel.notify()` in index.ts: logs the event but does not deliver. Phase 4 replaces with real channel.

## Self-Check: PASSED

- `src/webhook/multiQueue.ts` exists: YES
- `test/unit/multi-queue.test.ts` exists: YES
- Commit 0b43a99 exists: YES
- Commit 6948931 exists: YES
- All 223 tests pass: YES
- `npx tsc --noEmit` clean: YES
- `createMultiQueue<CascadeJob>` in src/index.ts: YES
- `createQueue<` in src/index.ts: NO (removed)
- `export type CascadeJob` in orchestrator.ts: YES
- `export type PushJob = Extract<CascadeJob` in orchestrator.ts: YES
- `enqueue(buildKey(` in pushHandler.ts: YES
- `source: "push"` in pushHandler.ts: YES
