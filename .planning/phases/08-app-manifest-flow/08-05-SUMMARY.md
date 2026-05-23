---
phase: 08-app-manifest-flow
plan: 05
subsystem: setup/manifestCallback
tags: [setup, csrf, manifest, callback, download, idempotency]
requires: [08-01, 08-02, 08-03]
provides:
  - registerManifestCallbackRoute
  - registerCredentialsDownloadRoute
  - renderSuccessPage
  - redactTail
affects:
  - src/setup/manifestCallback.ts
tech_stack_added: []
patterns:
  - msw-based in-process GitHub API mock (POST /app-manifests/{code}/conversions)
  - octokitFactory DI for test substitution without monkey-patching
  - persist-before-render strict ordering (Pitfall 2)
  - cookie-gated single-use download with Max-Age=0 self-revocation
key_files:
  created:
    - src/setup/manifestCallback.ts
    - test/unit/setup-manifest-callback.test.ts
  modified: []
decisions:
  - D-05 strict order conversion → persist → render upheld; refresh path reads from disk
  - D-09 CSRF mismatch logs presence flags only (has_cookie / has_query_state)
  - D-16 success page shows redacted tails (****<last4>); pemTail strips BEGIN/END markers + whitespace
  - D-17 download cookie single-use via Max-Age=0 self-revocation
  - D-20 anonymous Octokit via getAnonymousOctokit (injectable through octokitFactory)
metrics:
  duration: ~30 min
  completed: 2026-05-23
  tasks: 3
  tests: 24 added (0 → 24 in test/unit/setup-manifest-callback.test.ts)
  total_tests_after: 516/516 green
---

# Phase 8 Plan 05: Manifest Callback — Summary

One-liner: GET /setup/callback orchestrates CSRF → anonymous manifest conversion → atomic persist → success render, with refresh-idempotency and cookie-gated single-use credentials.env download — Pitfall 2 (lost credentials) and Pitfall 1 (one-shot code) both closed.

## Routes Registered

| Route | Method | Purpose |
|-------|--------|---------|
| `/setup/callback` | GET | CSRF gate → POST /app-manifests/{code}/conversions → persist → render success |
| `/setup/credentials.env` | GET | Cookie-gated single-use file download |

## Request-Handling Order (D-05)

`/setup/callback`:
1. Read state cookie (`readStateCookie`).
2. CSRF check: `safeEqualHex(cookie, query.state)` — fail-closed if either side missing or mismatched.
3. `missing_code` gate on absent `query.code`.
4. Branch:
   - **Fresh path** (`!credentials.exists()`): `octokit.request("POST /app-manifests/{code}/conversions")` → `credentials.persist(...)` → `log.info(setup_completed)`.
   - **Refresh path** (`credentials.exists()`): read from disk, skip conversion entirely (Pitfall 1 — code is single-use, 1h TTL).
5. `clearStateCookie` + `setDownloadCookie(randomUUID())`.
6. `renderSuccessPage` (strictly after persist).

`/setup/credentials.env`:
1. `readDownloadCookie` → 401 `download_not_authorized` if absent.
2. `credentials.read()` → 404 `credentials_not_found` (cookie cleared) if file missing.
3. `clearDownloadCookie` (self-revoke before sending body — single-use D-17).
4. Send body with `Content-Disposition: attachment; filename=credentials.env`.

## Error Paths

| Case | Status | Body | Persisted? |
|------|--------|------|------------|
| Missing `code` | 400 | `{error: "missing_code"}` | no |
| Missing cookie / state / mismatch | 400 | `{error: "csrf_mismatch"}` | no; state cookie cleared |
| Conversion 5xx / 4xx | 502 | `{error: "conversion_failed"}` | no |
| Persist throws (e.g. EACCES) | 500 | `{error: "persist_failed"}` | partial — log includes `app_id` so operator can delete the orphaned App on github.com |
| Disk vanished between exists() and read() (race) | 500 | `{error: "persist_failed"}` | n/a |
| Download without cookie | 401 | `{error: "download_not_authorized"}` | n/a |
| Download with cookie, file gone | 404 | `{error: "credentials_not_found"}` | n/a; download cookie cleared |

## Security Properties Verified

- **CSRF (D-09 / T-08-19):** mismatched / missing state never reaches `octokit.request` — verified by msw call counter (`h.calls === 0` for all failure paths).
- **Persist-before-render (D-05 / Pitfall 2 / T-08-23):** `persist` invocation order strictly precedes `read` (used by the render path) — verified via `vi.spyOn(...).mock.invocationCallOrder` ordering assertion.
- **No raw secrets in HTML (D-16 / T-08-21):** negative containment test asserts neither raw PEM body (`DEADBEEFCAFEBABE...`) nor raw webhook secret (`wh-secret-1234567890abcdef`) appear in success-page bytes; only `****<last4>` tails.
- **No raw secrets in logs (T-08-20):** `setup_completed` log payload contains only `{event, app_id, slug, html_url}`; explicit assertion that `pem` / `client_secret` / `webhook_secret` keys are absent. `grep -nE 'log\.(info|warn|error)\([^)]*\b(pem|client_secret|webhook_secret)\b'` on `src/setup/manifestCallback.ts` → zero matches.
- **Single-use download (D-17 / T-08-24):** first successful GET sets `auto_merge_setup_download=; Max-Age=0`; second GET without cookie → 401.

## Refresh Idempotency

A second GET `/setup/callback?code=...&state=...` (after credentials.env has been written) does NOT call the conversions endpoint — msw counter stays at 0 for that request, the success page is rendered from disk via `parseCredentialsEnv`. This guards against the most common operator mistake (refresh browser after seeing success) which would otherwise trigger a 422 from GitHub (code already consumed).

## Test Coverage (24 tests)

- 4 × `redactTail` (normal, short, undefined, empty).
- 6 × `renderSuccessPage` (doctype, APP_ID, redacted tails, download form, negative containment, purity).
- 10 × `registerManifestCallbackRoute` (missing code; csrf missing state / missing cookie / mismatch; happy path; refresh path; conversion 500; persist throws; persist-before-render ordering; csrf warn payload audit).
- 4 × `registerCredentialsDownloadRoute` (401 no cookie; 404 no file; 200 byte-equal + Max-Age=0; second GET → 401).

## Verification

- `npx vitest run test/unit/setup-manifest-callback.test.ts` → 24/24 green.
- `npx vitest run` → 516/516 green (full suite, no regressions).
- `npx tsc --noEmit` → clean.
- `grep -c 'as any' src/setup/manifestCallback.ts` → 0.

## Deviations from Plan

None. All 3 tasks executed exactly as specified; behaviour bullets and acceptance criteria upheld 1:1.

One minor implementation detail not pinned by the plan: the refresh path reconstructs `payload` from disk via a tiny `parseCredentialsEnv` helper (APP_ID + WEBHOOK_SECRET + PRIVATE_KEY block) — this symmetrises the render call between fresh and refresh paths without an in-memory cache. PEM tail is then computed by stripping BEGIN/END markers + whitespace before taking the last 4 base64 chars (D-16). `slug`/`html_url` are not reconstructed in refresh mode (they aren't in the .env file format from Plan 03); success page degrades gracefully (hides slug/link rows when absent).

## Decisions Referenced

D-05 (strict ordering), D-06 / D-09 (CSRF presence-only logging), D-15 (inline HTML template literal), D-16 (redacted tails), D-17 (single-use download cookie), D-20 (anonymous Octokit).

## Self-Check: PASSED

- `src/setup/manifestCallback.ts` exists.
- `test/unit/setup-manifest-callback.test.ts` exists.
- Commits:
  - `fbbcde6` test(08-05): add failing test for redactTail + renderSuccessPage
  - `8f8edb4` feat(08-05): redactTail + renderSuccessPage pure helpers
  - `be92383` test(08-05): add failing tests for callback + download routes
  - `409d337` feat(08-05): GET /setup/callback CSRF→conversion→persist→render + /setup/credentials.env download
