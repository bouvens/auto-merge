---
phase: 11-release-artifacts
plan: 2
subsystem: ci-cd
tags: [github-actions, docker, multi-arch, cosign, slsa, sbom, ghcr]
dependency_graph:
  requires: []
  provides:
    - .github/workflows/release.yml
  affects:
    - GHCR image registry
    - supply-chain attestation (Sigstore/Fulcio/Rekor)
tech_stack:
  added:
    - docker/build-push-action@v7.2.0 (provenance: mode=max, sbom: true)
    - sigstore/cosign-installer@v4.1.2 (keyless OIDC signing)
    - docker/metadata-action@v5 (semver + sha + latest tags)
    - docker/setup-buildx-action@v4
    - docker/login-action@v3
    - actions/upload-artifact@v4 / download-artifact@v4
  patterns:
    - matrix-per-arch on native runners (no QEMU)
    - push-by-digest + imagetools create for manifest assembly
    - cosign keyless sign on manifest-list digest (not per-arch)
key_files:
  created:
    - .github/workflows/release.yml
  modified: []
decisions:
  - "cosign-installer@v4.1.2 used instead of @v3 (REQUIREMENTS.md drift) — v3 cannot install Cosign 3.x"
  - "provenance: mode=max explicitly set — mode=min (default) is insufficient for SLSA L3"
  - ":latest tag always attached on tag push (no enable={{is_default_branch}}) — tag pushes have no branch context"
  - "Sign manifest-list digest extracted AFTER imagetools create — prevents signing per-arch digest (T-11-06)"
  - "docker/login-action@v3 retained — only mandatory drift correction was cosign-installer; login-action v3 remains functional"
metrics:
  duration: "~12 minutes"
  completed: "2026-05-27T17:30:47Z"
  tasks_completed: 1
  tasks_total: 1
  files_created: 1
  files_modified: 0
---

# Phase 11 Plan 2: release.yml Multi-arch GHCR + cosign + SLSA + SBOM Summary

**One-liner:** Multi-arch GHA release workflow — matrix native runners push per-arch digests, merge job assembles manifest list and signs with cosign keyless OIDC (SLSA mode=max + SBOM attached).

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Author .github/workflows/release.yml | 7ec7d1b | `.github/workflows/release.yml` |

## What Was Built

`.github/workflows/release.yml` implements a two-job release pipeline triggered by `v*.*.*` tag pushes:

**`build` job (matrix: amd64 + arm64):**
- Runs on native GitHub-hosted runners (`ubuntu-latest` for amd64, `ubuntu-24.04-arm` for arm64) — no QEMU emulation
- Builds with `docker/build-push-action@v7.2.0` using `provenance: mode=max` and `sbom: true`
- Pushes per-arch images by digest (`push-by-digest=true`) — no tag race conditions
- Uploads digest filenames as artifacts (`digest-amd64`, `digest-arm64`)

**`merge` job:**
- Downloads both digest artifacts and assembles a multi-arch manifest list via `docker buildx imagetools create`
- Tags: semver (`v1.2.3`), short SHA (`sha-abc1234`), and `:latest`
- Extracts manifest-list digest via `imagetools inspect --format '{{json .Manifest}}' | jq -r '.digest'`
- Signs the manifest-list digest with `cosign sign --yes` using keyless OIDC (Fulcio ephemeral cert logged to Rekor)

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

### Drift Corrections Applied (from RESEARCH.md)

**1. [RESEARCH drift correction] cosign-installer@v4.1.2 instead of @v3**
- REQUIREMENTS.md specified `sigstore/cosign-installer@v3`
- RESEARCH.md confirmed v3 cannot install Cosign 3.x — flag incompatibilities at runtime
- Used `@v4.1.2` as directed; inline comment explains why

## Known Stubs

None — the workflow file is complete and self-contained. Runtime verification (pushing a tag) is out of scope for this plan; documented in 11-06-PLAN.md per `<success_criteria>`.

## Threat Flags

No new security surface beyond what is documented in the plan's `<threat_model>`. All identified threats (T-11-SC, T-11-04 through T-11-08) are mitigated or accepted as documented.

## Self-Check: PASSED

- `.github/workflows/release.yml` exists: FOUND
- Commit `7ec7d1b` exists: FOUND
- `sigstore/cosign-installer@v4.1.2` count = 1: PASS
- `docker/setup-qemu-action` count = 0: PASS
- `provenance: mode=max` count = 1: PASS
- `sbom: true` count = 1: PASS
- `id-token: write` count ≥ 1 (= 2): PASS
- `imagetools inspect` count ≥ 1: PASS
- `build` and `merge` jobs declared: PASS
- `linux/amd64` on `ubuntu-latest` + `linux/arm64` on `ubuntu-24.04-arm`: PASS
