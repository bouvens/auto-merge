---
phase: 02-cascade-engine
plan: 06
subsystem: cascade
tags: [conflict, pull-requests, idempotency, github-app]
requires:
  - src/log.ts
provides:
  - createConflictPR
  - ConflictPRDeps
  - ConflictPROpts
  - ConflictPRResult
affects:
  - cascade orchestrator (plan 02-07 will call createConflictPR on mergeStep conflict outcome)
tech-stack:
  added: []
  patterns:
    - octokit.request("ROUTE", params) call style (mirrors src/config/loader.ts)
    - status-of-error detection via (err as { status?: number }).status
    - structured log events with stable event names for grep/alerting
key-files:
  created:
    - src/cascade/conflict.ts
    - test/unit/cascade-conflict.test.ts
  modified: []
decisions:
  - D-19/D-20 idempotency: 422 on createRef → list open PR → reuse or create-new-on-same-ref
  - D-21 PR body: 3-line minimal (failure summary + run_id + Check Run link), no conflict-file list (Merges API doesn't expose it)
  - D-22 PR title: literal "Auto-merge conflict: {src} → {tgt} ({short_sha})", not draft, no labels
  - D-23 author chain: push payload username → repos.getCommit author.login → email-without-@-mention
metrics:
  duration: ~12 min
  completed: 2026-05-21T12:43:26Z
  tasks_completed: 1
  files_created: 2
  tests_added: 10
---

# Phase 2 Plan 06: Conflict PR Creation Summary

One-liner: `createConflictPR` materialises the branch + PR for a failed merge, with 422-idempotency on createRef and pulls.create plus a three-step author resolution chain — no DB, no local clone, all server-side via `octokit.request`.

## What Was Built

- **`src/cascade/conflict.ts`** — exports `createConflictPR(deps, opts) → ConflictPRResult`.
  - Step 1: `POST /repos/{owner}/{repo}/git/refs` to create `auto-merge/conflict-{src}-{tgt}-{short_sha}` pointing at `source_sha`.
  - On 422 (branch exists): list open conflict PRs via `GET /pulls?head={owner}:{branch}&state=open`. If found → return `{reused: true}`. Else fall through to PR creation on existing ref.
  - Step 2: Resolve author per D-23 chain (`headCommitAuthor.username` → `repos.getCommit.author.login` → `(author email: …)` fallback). `getCommit` errors swallowed → email fallback.
  - Step 3: Compose 3-line PR body (D-21) and `POST /repos/{owner}/{repo}/pulls`.
  - On 422 from `pulls.create` (race): retry `pulls.list` once. If found → reused. Else `{ok: false}`.
  - Structured log events at each transition: `cascade_conflict_branch_created`, `cascade_conflict_branch_exists`, `cascade_conflict_pr_reused`, `cascade_conflict_pr_created`, `cascade_conflict_pr_failed`.

- **`test/unit/cascade-conflict.test.ts`** — 10 unit tests, all green:
  1. Happy path (createRef 201 + username) → new PR, body asserts.
  2. createRef 422 + open PR exists → reused, `pulls.create` not called.
  3. createRef 422 + empty list → new PR on same ref.
  4. Author chain step 2: getCommit `{author: {login: "bob"}}` → `@bob`.
  5. Author chain step 3: getCommit throws → email fallback.
  6. Author chain step 3: getCommit `{author: null}` → email fallback.
  7. `checkRunHtmlUrl = null` → body shows `(not available)`.
  8. createRef 500 → `{ok: false, error: "createRef failed: …"}`.
  9. `pulls.create` 422 race → retry pulls.list finds PR → reused.
  10. `pulls.create` 422 race → retry still empty → `{ok: false}`.

## Verification

- `npm test`: 73/73 passed (entire suite; 13 files).
- `npm test -- test/unit/cascade-conflict.test.ts`: 10/10 passed.
- `npm run typecheck`: clean.
- `npm run lint`: 2 pre-existing errors and 8 `noNonNullAssertion` warnings inherited from baseline (`src/config/loader.ts:94`, `src/auth.ts` format, `src/index.ts`). Our files contribute only the `noNonNullAssertion` warning style that is already an accepted project convention. No new error categories introduced.
- `grep -c "octokit.request" src/cascade/conflict.ts` → 4 (createRef, pulls.list called from two paths, pulls.create, repos.getCommit).
- `grep -E "switch \(" src/cascade/conflict.ts` → no matches (object-map / linear flow only).
- No `any` type in the new module.

## Deviations from Plan

None — plan executed exactly as written.

Notes on lint:

- Baseline (HEAD~2) already had 2 lint errors and a non-fixable `noNonNullAssertion` warning in `src/config/loader.ts:94`. These pre-existing issues are out of scope for this plan (Rule scope-boundary). Logged for visibility, not fixed.
- Our test file picked up `lint/style/noNonNullAssertion` warnings on `[]!` indexing, consistent with `test/unit/config-loader-parse.test.ts:16,27` — same idiom, same project-accepted convention.

## Requirements Covered

- **CONF-01** — conflict-outcome path produces a branch + PR (next plan wires `mergeStep` → `createConflictPR`).
- **CONF-02** — branch name is `auto-merge/conflict-{src}-{tgt}-{short_sha}`; PR head/base set per spec.
- **CONF-03** — @author resolution chain implemented per D-23.
- **CONF-05** — PR body excludes any conflict-file list (none is available from Merges API; GitHub PR UI shows files itself).

## Threat Surface Notes

No new surface beyond what's in `<threat_model>`. Email fallback uses literal `(author email: …)` prefix — no `@`-mention rendering possible from a hostile email (T-02-25 mitigated as planned).

## Commits

- `8c436ef` test(02-06): add failing tests for createConflictPR
- `22b8402` feat(02-06): createConflictPR with idempotent branch+PR creation

## Self-Check: PASSED

- `src/cascade/conflict.ts` — FOUND
- `test/unit/cascade-conflict.test.ts` — FOUND
- Commit `8c436ef` — FOUND
- Commit `22b8402` — FOUND
