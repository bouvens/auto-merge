---
phase: 11-release-artifacts
plan: 5
subsystem: examples/paas
tags: [fly.io, render.com, deployment, paas, templates, REL-07]
dependency_graph:
  requires: [11-01]  # REL-08 base64-PEM decode is operational
  provides: [fly.toml, render.yaml, paas-readmes]
  affects: []
tech_stack:
  added: []
  patterns: [fly.toml http_service, render.yaml blueprint, base64-PEM workflow]
key_files:
  created:
    - examples/paas/fly/fly.toml
    - examples/paas/fly/README.md
    - examples/paas/render/render.yaml
    - examples/paas/render/README.md
  modified: []
decisions:
  - "fly.toml has no [build] block — operator deploys via flyctl deploy --image, not from source"
  - "render.yaml autoDeploy:false to prevent surprise redeploys; operator triggers manually after cosign verify"
  - "Both templates pin semver tag, not :latest — documented in READMEs"
metrics:
  duration: "~8 minutes"
  completed: "2026-05-27T17:42:23Z"
  tasks_completed: 2
  files_created: 4
---

# Phase 11 Plan 5: Fly.io + Render.com PaaS Templates Summary

Delivered four-file PaaS blueprint set: Fly.io `fly.toml` + README, Render.com `render.yaml` + README. Both templates leverage REL-08 base64-PEM decode for frictionless single-line PRIVATE_KEY injection in PaaS secret managers.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fly.io template (fly.toml + README) | 0da6682 | `examples/paas/fly/fly.toml`, `examples/paas/fly/README.md` |
| 2 | Render.com template (render.yaml + README) | 6b8913f | `examples/paas/render/render.yaml`, `examples/paas/render/README.md` |

## Artifacts

### examples/paas/fly/fly.toml

- `app = "auto-merge"` placeholder with inline comment
- `primary_region = "iad"` (us-east, closest to GitHub's webhook origin)
- `[env]` block: `NODE_ENV=production`, `PORT=3000`
- `[http_service]`: `internal_port=3000`, `force_https=true`, `auto_stop_machines=false` (Pitfall 6 mitigation), `auto_start_machines=true`
- `[[http_service.checks]]`: `path="/healthz"`, `interval=30s`, `timeout=5s`, `grace_period=15s`
- `[[vm]]`: `size=shared-cpu-1x`, `memory=256mb`
- No `[build]` block — image-only deploy via `flyctl deploy --image`

### examples/paas/fly/README.md

Step-by-step guide covering: app creation, secrets setup with base64-PEM workflow, cosign verify, deploy, webhook URL update, verification commands, troubleshooting (machine hibernation, multi-line PEM, private GHCR), cost note.

### examples/paas/render/render.yaml

- `services[0].type: web`, `runtime: image`, `name: auto-merge`
- `image.url: ghcr.io/OWNER/auto-merge:v1.1.0` with semver-pin comment
- `plan: starter`, `region: oregon`, `healthCheckPath: /healthz`, `autoDeploy: false`
- 6 env vars with `sync: false` (APP_ID, WEBHOOK_SECRET, PRIVATE_KEY with base64 comment, SLACK_WEBHOOK_URL, TELEGRAM_BOT_TOKEN, DIAGNOSE_TOKEN)
- `NODE_ENV=production`, `PORT=3000` as static values

### examples/paas/render/README.md

Step-by-step guide covering: Blueprint creation, env var table with base64-PEM workflow, cosign verify, Blueprint apply, webhook URL update, verification commands, troubleshooting (private GHCR registryCredential, tag drift, autoDeploy), cost note.

## Threat Mitigations Applied

| Threat ID | Mitigation |
|-----------|-----------|
| T-11-19 (secrets in render.yaml) | All sensitive envVars use `sync: false`; values never committed |
| T-11-20 (Fly hibernation drops webhooks) | `auto_stop_machines = false` enforced in template; README explains cost trade-off |
| T-11-21 (:latest tag tampering) | Template pins semver tag; README recommends cosign verify before bumping; `autoDeploy: false` prevents surprise Render pulls |
| T-11-22 (private GHCR pull) | Accepted per threat register; README documents `registryCredential` path for private repos |

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `examples/paas/fly/fly.toml` exists, parses as TOML, contains `auto_stop_machines = false` and `/healthz`
- `examples/paas/fly/README.md` exists, non-empty, documents `fly secrets set PRIVATE_KEY=...base64...` and cosign verify
- `examples/paas/render/render.yaml` exists, parses as YAML (via project yaml package), contains `runtime: image`, `healthCheckPath: /healthz`, 6× `sync: false`
- `examples/paas/render/README.md` exists, non-empty, documents base64-PEM workflow and cosign verify
- Commits 0da6682 and 6b8913f verified in git log
