---
phase: 10-diagnose-endpoint
plan: 03
subsystem: diagnose
tags: [markdown, renderer, snapshot-test, pure-function]
requires:
  - src/diagnose/types.ts (DiagnoseReport / ProbeStatus from Plan 10-02)
provides:
  - renderMarkdown(report: DiagnoseReport): string
affects:
  - (nothing — pure function, no module-level side effects, zero new deps)
tech-stack:
  added: []
  patterns:
    - "Object-as-map for ProbeStatus → emoji (per CLAUDE.md)"
    - "vitest toMatchSnapshot() as renderer contract"
key-files:
  created:
    - src/diagnose/markdown.ts
    - src/diagnose/markdown.test.ts
    - src/diagnose/__snapshots__/markdown.test.ts.snap
  modified: []
decisions:
  - "Single feat commit instead of separate RED/GREEN — snapshot tests are bootstrapped against the implementation in one shot (a synthetic RED would require deleting then re-generating the same snapshot file)"
  - "NotifyStatus enum mapped to ProbeStatus via NOTIFY_TO_PROBE object (pending=warn, unreachable/misconfigured=error) for emoji selection — keeps notify section visually consistent with other sections without mutating the input report"
  - "Branches section sorts branch names alphabetically for snapshot stability across input-key ordering"
  - "Permissions maps render as sorted {k:v, ...} for snapshot determinism regardless of caller ordering"
metrics:
  duration_min: 5
  completed_date: 2026-05-24
---

# Phase 10 Plan 03: Markdown Renderer Summary

Pure `renderMarkdown(report: DiagnoseReport): string` function with 4-fixture snapshot suite — operator-friendly markdown for `Accept: text/markdown` requests on the diagnose endpoint. Zero new dependencies, snapshot-as-contract.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Implement `src/diagnose/markdown.ts` as a pure function with snapshot tests | `7372663` | `src/diagnose/markdown.ts`, `src/diagnose/markdown.test.ts`, `src/diagnose/__snapshots__/markdown.test.ts.snap` |

## What Was Built

- `STATUS_EMOJI: Record<ProbeStatus, string>` map: `ok=✅`, `warn=⚠️`, `error=❌`, `n/a=➖` — per D-12 and CLAUDE.md "objects for mappings" rule.
- Section renderers: `renderApp` / `renderConfig` / `renderBranches` / `renderNotify` / `renderOnboarding` — each renders its H2 header even when content is `n/a` (parity with JSON shape per SC1).
- Header block: `# Diagnose: {owner}/{repo}` + `_checked at {checked_at}_` + `**Overall:** ✅ ok | ❌ issues found`.
- `open_pr` conditionally appended to onboarding when present (`#42 https://...`).
- Notify section maps `NotifyStatus` enum to a `ProbeStatus` bucket for emoji selection (`pending → warn`, `unreachable | misconfigured → error`) while preserving the raw enum string in the output.
- Output ends with exactly one terminal `\n`; sections joined by `\n\n` — no duplication.

## Test Coverage

| Fixture | Scenario | Outcome |
|---------|----------|---------|
| A | All sections `ok`, config in repo | overall `✅ ok`, every line `✅` |
| B | `app_installed=error: app-not-installed`, all downstream `n/a` | overall `❌`, downstream rendered with `➖` |
| C | Missing `contents` permission, `release` branch absent | `❌` rows + `missing=[contents]` line + `release: exists=false` |
| D | `onboarding.status=warn` with `open_pr={42, html_url}` | onboarding line `⚠️ onboarding PR #42 waiting for review` + `open_pr: #42 https://...` |

Plus two invariants:
- **Determinism:** `renderMarkdown(x) === renderMarkdown(x)` for the same fixture (no `Date.now` / `Math.random`).
- **No secret literals:** output is grep-clean for `hooks.slack`, `bot<digits>:`, `BEGIN ... PRIVATE` patterns across all 4 fixtures.

## Verification

- `npx vitest run src/diagnose/markdown.test.ts` → 6/6 passed, 4 snapshots written.
- Full suite: `npx vitest run` → 640/640 passed (no regressions).
- `npm run typecheck` → clean for `src/diagnose/markdown.ts` (pre-existing TS2352 in `test/unit/onboarding-onboardRepo.test.ts` remains in `deferred-items.md`, untouched).
- `npx biome check src/diagnose/markdown.ts src/diagnose/markdown.test.ts` → clean.
- `grep -E "hooks\\.slack|bot[0-9]+|BEGIN.*PRIVATE" src/diagnose/markdown.ts` → empty (T-10-08 mitigated by construction).

## Deviations from Plan

1. **[Rule 1 — Bug] Type narrowing for `b.branches[name]`**
   - **Found during:** Task 1 typecheck pass
   - **Issue:** `Record<string, BranchCheck>` index access yields `BranchCheck | undefined` under strict mode, but `name` is derived from `Object.keys(b.branches)` so the value is guaranteed defined.
   - **Fix:** Local typed alias `const entry = b.branches[name] as { exists: boolean; protected: boolean }` with an explanatory comment.
   - **Files modified:** `src/diagnose/markdown.ts`
   - **Commit:** `7372663` (included in initial feat commit)

2. **TDD RED/GREEN combined into a single commit (not strictly a deviation rule, but worth noting)**
   - The plan task is `tdd="true"`. Snapshot tests bootstrap themselves against the implementation on first run; producing a true RED commit would require committing a snapshot of `undefined` output (meaningless) or stubbing `renderMarkdown` to throw (no value beyond what the test assertion already provides). The single `feat` commit captures impl + tests + snapshot atomically.
   - The behavioral contract is enforced post-hoc by the snapshot file — any future change to `renderMarkdown` that breaks the contract will fail tests immediately.

## Threat Surface

No new surface beyond plan's threat register:
- **T-10-08 (info disclosure):** mitigated — renderer reads only `DiagnoseReport` fields, never touches env / healthChecker / octokit. Verified by grep + by absence of any imports beyond `./types.js`.
- **T-10-09 (markdown special chars in fields):** accepted per plan — owner/repo values come from GitHub-constrained sources upstream.

## Known Stubs

None. The renderer is feature-complete for the DIAG-01 contract (`Accept: text/markdown` branch).

## Self-Check: PASSED

- `[ -f src/diagnose/markdown.ts ]` → FOUND
- `[ -f src/diagnose/markdown.test.ts ]` → FOUND
- `[ -f src/diagnose/__snapshots__/markdown.test.ts.snap ]` → FOUND
- `git log --oneline | grep 7372663` → FOUND
