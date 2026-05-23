---
phase: 08-app-manifest-flow
plan: 03
subsystem: setup
tags: [setup, credentials, persistence, ttl, atomic-write]
requires:
  - SETUP_OUTPUT_DIR env (Plan 08-01)
provides:
  - createCredentialsStore({dir, log}) closure factory
  - checkStaleOnBoot(dir, log) boot-time cleanup
  - formatEnvFile(payload) pure serializer
  - CredentialsPayload + CredentialsStore types
  - CREDENTIALS_FILENAME, TTL_MS constants
affects:
  - src/setup/credentials.ts (NEW)
  - test/unit/setup-credentials.test.ts (NEW)
tech-stack:
  added: []
  patterns: [closure-factory, atomic-write-rename, setTimeout-unref, boot-stale-check]
key-files:
  created:
    - src/setup/credentials.ts
    - test/unit/setup-credentials.test.ts
  modified: []
decisions:
  - D-01 (SETUP_OUTPUT_DIR consumed by store)
  - D-02 (atomic write via tmp+rename; mode 0o600 on tmp survives rename)
  - D-03 (setTimeout.unref TTL cleanup)
  - D-04 (checkStaleOnBoot covers restart-killed TTL)
  - D-05 (read() supports refresh-from-disk idempotency for /setup/callback)
metrics:
  tasks_completed: 3
  files_created: 2
  tests_added: 18
  duration_minutes: ~10
  completed: 2026-05-23
---

# Phase 8 Plan 3: Credentials persistence — atomic write + TTL + boot-stale check

## One-liner

`src/setup/credentials.ts` — closure-factory store with atomic POSIX rename, mode-0600 on-disk, TTL setTimeout, and a standalone `checkStaleOnBoot` for restart safety.

## What shipped

- **`formatEnvFile(payload)`** — pure serializer producing dotenv-compatible body. `PRIVATE_KEY` uses quoted multi-line form so PEM newlines survive parsing (Pitfall 5). Null `webhook_secret` throws loudly rather than writing a broken `.env`.
- **`createCredentialsStore({dir, log})`** — returns `{ persist, read, exists, delete, getPath }`:
  - `persist` writes to `${final}.tmp-${pid}` with `{ mode: 0o600 }`, then `renameSync` to final. Tmp lives in the same directory as final to avoid `EXDEV` on cross-fs mounts (Pitfall 2). Mode survives rename on POSIX. After successful rename, schedules `setTimeout(unlinkSync, TTL_MS).unref()` so the event loop is not held open.
  - `read` returns `Buffer | null` (ENOENT → null, all other errors propagate).
  - `exists` swallows ENOENT, returns boolean from `statSync().isFile()`.
  - `delete` swallows ENOENT, always logs `setup_credentials_deleted`.
  - TTL fire: if the file was already deleted manually, ENOENT is swallowed silently; any other unlink error logs `setup_ttl_unlink_failed` at warn level (not fatal — the event loop has already returned).
- **`checkStaleOnBoot(dir, log)`** — `statSync(credentials.env)`; if `mtimeMs < now - TTL_MS`, unlinks the file and logs `setup_stale_cleanup`. ENOENT (steady state) is silent. Non-ENOENT (EACCES, EIO, ENOTDIR) is **re-thrown** so an operator notices a permission misconfig at boot rather than running with a silently-broken stale-check.

## Atomic write strategy

```
1. body  = formatEnvFile(payload)
2. write body → ${dir}/credentials.env.tmp-${pid}  (mode 0o600)
3. rename(tmp → ${dir}/credentials.env)            (atomic on same FS)
4. on failure: best-effort unlink(tmp), re-throw
5. schedule setTimeout(unlinkSync(final), 3_600_000).unref()
```

Mode is set on the tmp file **before** rename — verified by test asserting `statSync(getPath()).mode & 0o777 === 0o600` after persist. Idempotent overwrite verified by two sequential persist calls reading back the second payload's content.

## TTL behaviour

- Single `setTimeout` per `persist()` call; `.unref()` so it does not pin the event loop after `app.close()`.
- Successful fire → `unlinkSync(final)` + `log.info({event:"setup_credentials_expired", path}, "setup")`.
- File already gone when timer fires → ENOENT swallowed, no warn (the manual-delete + TTL test asserts no `setup_ttl_unlink_failed` warn).
- Cross-restart gap is handled by `checkStaleOnBoot`, not by attempting to persist the timer.

## Boot stale-check semantics

| Condition | Behaviour |
|-----------|-----------|
| File missing | silent return (ENOENT) |
| File mtime within TTL | silent return (no log, file preserved) |
| File mtime > TTL ago | `unlinkSync` + `log.info setup_stale_cleanup` |
| Non-ENOENT statSync error | re-throw (operator sees deploy-time misconfig) |

The "re-throw on non-ENOENT" choice mirrors the assertive boot path in `src/config/defaultLoader.ts` for missing-config-at-boot (D-03 in Phase 7) — boot-time issues should fail loudly, not silently.

## Tests

- 18 assertions in `test/unit/setup-credentials.test.ts`:
  - `formatEnvFile`: 4 (headers, fields, quote-escape, trailing newline, null guard).
  - `createCredentialsStore`: 10 (path, exists, mode, idempotent overwrite, read+null, delete+log, delete-ENOENT silent, TTL fire, manual-delete-then-TTL ENOENT silence, tmp not lingering).
  - `checkStaleOnBoot`: 4 (no file, stale, fresh, non-ENOENT re-throw via ENOTDIR pointing at a regular-file's nonexistent subdir — works in ESM without mocking `node:fs`).
- Test harness: `mkdtemp(tmpdir(), "setup-credentials-")` + `vi.useFakeTimers()` for TTL, matching the `default-loader-hot-reload.test.ts` analog.

## Deviations from Plan

### Adjusted: EACCES test → ENOTDIR test

- **Found during:** Task 3.
- **Issue:** Plan acceptance criterion suggested `vi.spyOn(fs, 'statSync').mockImplementation` for a permission-denied simulation. Vitest under ESM cannot redefine `statSync` on the `node:fs` namespace (`TypeError: Cannot redefine property: statSync`).
- **Fix:** Replaced with a deterministic ENOTDIR scenario — `checkStaleOnBoot` called on a path whose parent is a regular file (`<dir>/regular-file/subdir`). `statSync` throws `ENOTDIR`, which is non-ENOENT → the re-throw branch is exercised exactly as intended without ESM-module mocking.
- **Coverage parity:** Behaviour bullet «non-ENOENT statSync error is re-thrown» is covered; the specific errno (ENOTDIR vs EACCES) is irrelevant to the contract.
- **Commit:** d77ab75.

### None outside plan scope.

## Decisions referenced

- **D-01** (SETUP_OUTPUT_DIR): consumed by `createCredentialsStore({dir})` argument; the store is path-agnostic, decoupling from env-shape changes.
- **D-02** (atomic write): tmp suffix `${final}.tmp-${pid}` in same directory; `writeFileSync(tmp, {mode:0o600})` + `renameSync`.
- **D-03** (TTL setTimeout): `.unref()` applied; ENOENT during fire is swallowed.
- **D-04** (boot stale): exported as standalone `checkStaleOnBoot` for Plan 06 to wire into `src/index.ts`.
- **D-05** (refresh idempotency): `read()` returns Buffer-or-null so `/setup/callback` in Plan 05 can render success from disk on refresh without repeating the conversion call.

## Key links (downstream consumers)

| From | To | Pattern |
|------|----|---------|
| `src/setup/manifestForm.ts` (Plan 04) | `store.exists()` | duplicate-setup guard on GET /setup/new |
| `src/setup/manifestCallback.ts` (Plan 05) | `store.persist + store.read` | persist-before-render; refresh-from-disk |
| `src/index.ts` (Plan 06) | `checkStaleOnBoot` | boot-time invariant restoration |

## Threat model — mitigations landed

| Threat ID | Mitigation as implemented |
|-----------|---------------------------|
| T-08-09 (world-readable credentials) | `writeFileSync(tmp, {mode:0o600})` BEFORE rename; mode-survives-rename verified by test. |
| T-08-10 (partial-write visible) | tmp+rename inside same dir; reader either sees no file or a complete one. |
| T-08-11 (restart kills TTL → leak) | `checkStaleOnBoot` re-runs the invariant on next boot. |
| T-08-12 (payload leaked to pino) | Store logs only `path` / `mtimeMs` / event names — never payload values. |

## Self-Check: PASSED

- `[x] src/setup/credentials.ts` exists, contains `renameSync` (2 occurrences), `0o600` (1), `.unref` (1), `tmp-${process.pid}` (1).
- `[x] test/unit/setup-credentials.test.ts` exists with 18 tests, all green.
- `[x] npx vitest run test/unit/setup-credentials.test.ts` — 18/18.
- `[x] npx tsc --noEmit` — no errors.
- `[x] npx biome check src/setup/credentials.ts test/unit/setup-credentials.test.ts` — clean.
- `[x] Commit 8e87b9b` — formatEnvFile.
- `[x] Commit cfbd9ed` — createCredentialsStore.
- `[x] Commit d77ab75` — checkStaleOnBoot.
