---
phase: 04-notifications-release
plan: 05
subsystem: release-artifacts
tags: [dockerfile, readme, changelog, docker, release]
dependency_graph:
  requires: [04-04]
  provides: [release-artifacts-complete, docker-image-pinned, self-host-docs]
  affects: [Dockerfile, .dockerignore, README.md, CHANGELOG.md]
tech_stack:
  added: []
  patterns: [digest-pinned base image, multi-stage Docker, Keep a Changelog]
key_files:
  created:
    - CHANGELOG.md
  modified:
    - Dockerfile
    - .dockerignore
    - README.md
decisions:
  - name: busybox wget is sufficient for HEALTHCHECK
    rationale: Alpine bundles busybox wget; no additional apk install needed (RESEARCH.md line 578). Avoids unnecessary package in the runtime image surface.
  - name: node:24-alpine pinned by sha256 digest in both stages
    rationale: Digest pins prevent supply-chain attacks via tag mutation (T-04-18). Both builder and runtime stages use the same digest for consistency.
  - name: OWNER/REPO in CHANGELOG replaced with bouvens/auto-merge
    rationale: git remote confirms origin is git@github.com:bouvens/auto-merge.git.
metrics:
  duration: ~15 minutes
  completed: 2026-05-22
  tasks_completed: 2
  files_modified: 4
---

# Phase 04 Plan 05: Release Artifacts Summary (draft — smoke checkpoint pending)

Prepared v1.0 release artifacts: Dockerfile upgraded to node:24-alpine pinned by sha256 digest, .dockerignore excludes dist/, README rewritten with all 8 D-18 sections, CHANGELOG.md created in Keep a Changelog format.

> **STATUS: DRAFT** — Task 3 (Docker smoke verification) is a `checkpoint:human-verify` gate that has not yet been approved. This SUMMARY will be finalized after smoke test passes.

## Tasks Completed

### Task 1: Dockerfile upgrade + .dockerignore

**Commit:** `c20c9e0`

- `Dockerfile`: replaced `FROM node:22-alpine` with `FROM node:24-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14` in both builder and runtime stages (D-16, T-04-18). Added comment explaining busybox wget sufficiency above HEALTHCHECK (T-04-22). HEALTHCHECK, USER node, ENTRYPOINT, CMD unchanged.
- `.dockerignore`: appended `dist/` with explanatory comment (D-17) to prevent host tsc output from shadowing builder stage output.

### Task 2: README.md (D-18, 8 sections) + CHANGELOG.md

**Commit:** `cc556be`

- `README.md`: complete rewrite with 14 H2 sections covering all 8 D-18 requirements: What & Why, Quickstart (file-mount and inline key variants), Env Vars Table (all Phase 1-4 vars including CRON_SCHEDULE, CRON_TZ, NOTIFY_*), GitHub App Setup (5-step ordered list with all required permissions), Slack Setup (Incoming Webhooks walkthrough), Telegram Setup (BotFather + getUpdates), Per-Repo Config (full .github/auto-merge.yml example), workflow_dispatch Trigger Snippet (verbatim from Phase 3 D-11), Troubleshooting (6 entries with dead-letter patterns), plus Health Endpoints, Graceful Shutdown, Local Development, Scripts, Build from Source.
- `CHANGELOG.md`: created in Keep a Changelog 1.1.0 format with `[1.0.0] - 2026-05-22` section listing 16 Phase 1-4 features. Links use `bouvens/auto-merge` (confirmed via `git remote -v`).

## Tasks Pending

### Task 3: Docker smoke verification (checkpoint:human-verify — NOT YET EXECUTED)

The plan requires a human-verify checkpoint before this plan is considered complete:

1. `docker build -t auto-merge:test .` — expected: successful build
2. `docker image inspect auto-merge:test` — expected: USER=node, Entrypoint=/sbin/tini, HEALTHCHECK uses wget+healthz
3. Run with stub env, check `/healthz` returns 200, `/proc/1/comm` == `tini`
4. Visual review of README and CHANGELOG

The v1.0.0 git tag is NOT created here — operator creates it after smoke approval.

## Deviations from Plan

None — plan executed exactly as written for Tasks 1 and 2.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints or auth paths introduced. Dockerfile changes are config-only. README examples use placeholders only (T-04-20 compliance confirmed).

## Self-Check: PASSED

- `c20c9e0` exists in git log ✓
- `cc556be` exists in git log ✓
- `grep -c 'node:24-alpine@sha256:2bdb65ed...' Dockerfile` === 2 ✓
- `grep -c 'node:22-alpine' Dockerfile` === 0 ✓
- `grep -c '^dist/$' .dockerignore` === 1 ✓
- `grep -c '^## ' README.md` === 14 (>= 8 required) ✓
- `grep -c '## [1.0.0]' CHANGELOG.md` === 1 ✓
- `grep -c 'Keep a Changelog' CHANGELOG.md` === 1 ✓
