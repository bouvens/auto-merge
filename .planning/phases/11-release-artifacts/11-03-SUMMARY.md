---
phase: 11-release-artifacts
plan: 3
subsystem: deploy/helm
tags: [helm, kubernetes, security, release]
dependency_graph:
  requires: []
  provides: [helm-chart-auto-merge]
  affects: []
tech_stack:
  added: []
  patterns: [helm-fail-guard, existingSecretName-envFrom, pod-security-context]
key_files:
  created:
    - deploy/helm/auto-merge/Chart.yaml
    - deploy/helm/auto-merge/values.yaml
    - deploy/helm/auto-merge/.helmignore
    - deploy/helm/auto-merge/templates/_helpers.tpl
    - deploy/helm/auto-merge/templates/NOTES.txt
    - deploy/helm/auto-merge/templates/deployment.yaml
    - deploy/helm/auto-merge/templates/service.yaml
    - deploy/helm/auto-merge/templates/ingress.yaml
    - deploy/helm/auto-merge/templates/serviceaccount.yaml
  modified: []
decisions:
  - "strategy: Recreate (not RollingUpdate) — single-replica + in-memory queue means no overlap is safe"
  - "readOnlyRootFilesystem: false as default (opt-in after operator verifies no runtime writes)"
  - "{{ fail }} placed as first directive in deployment.yaml before any YAML output (catches install AND upgrade)"
  - "automountServiceAccountToken: false on both ServiceAccount and PodSpec — app never calls k8s API"
metrics:
  duration: 137s
  completed: 2026-05-27
  tasks_completed: 2
  files_created: 9
---

# Phase 11 Plan 3: Helm Chart deploy/helm/auto-merge Summary

Helm 3 chart for single-command k8s self-hosting: `helm install auto-merge ./deploy/helm/auto-merge --set existingSecretName=<secret>` with hard replicaCount=1 guard, zero secrets in values.yaml, and pod security matching Dockerfile uid 1000.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Chart.yaml + values.yaml + helpers + .helmignore | 64b6b80 | Chart.yaml, values.yaml, _helpers.tpl, NOTES.txt, .helmignore |
| 2 | deployment.yaml + service.yaml + ingress.yaml + serviceaccount.yaml | 6a0236a | 4 template files |

## Verification Results

- `helm lint deploy/helm/auto-merge` — passes (INFO: icon recommended only)
- `helm template --set existingSecretName=test-secret` — renders Deployment + Service + ServiceAccount
- `helm template --set replicaCount=2` — exits 1 with "replicaCount must be 1" message
- `helm template` (no existingSecretName) — exits 1 with "existingSecretName must be set" message
- Rendered Deployment: `runAsNonRoot: true`, `runAsUser: 1000`, `terminationGracePeriodSeconds: 60`, `/readyz` readiness, `/healthz` liveness
- Zero inline secret literals in rendered output

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface Scan

All five threats from plan threat_model addressed:

| Threat | Mitigation | Verified |
|--------|-----------|---------|
| T-11-09: PRIVATE_KEY in values.yaml | existingSecretName only; required errors if unset | helm template without flag exits non-zero |
| T-11-10: replicaCount>1 corrupts state | {{ fail }} first line of deployment.yaml | helm template --set replicaCount=2 exits non-zero |
| T-11-11: container escape to root | runAsNonRoot:true, runAsUser:1000, allowPrivilegeEscalation:false, capabilities.drop:ALL | rendered YAML verified |
| T-11-12: mounted SA token leaks | automountServiceAccountToken:false on SA + PodSpec | rendered YAML verified |
| T-11-13: resource exhaustion | resources.limits in values.yaml defaults | rendered YAML verified |

No new security surface introduced beyond what was planned.

## Known Stubs

None — chart is fully functional. `OWNER` placeholder in `image.repository` and `home`/`sources` in Chart.yaml is intentional documentation: operator replaces with their actual GitHub org/username at install time.

## Self-Check: PASSED

Files exist:
- deploy/helm/auto-merge/Chart.yaml ✓
- deploy/helm/auto-merge/values.yaml ✓
- deploy/helm/auto-merge/templates/_helpers.tpl ✓
- deploy/helm/auto-merge/templates/deployment.yaml ✓
- deploy/helm/auto-merge/templates/service.yaml ✓
- deploy/helm/auto-merge/templates/ingress.yaml ✓
- deploy/helm/auto-merge/templates/serviceaccount.yaml ✓

Commits:
- 64b6b80 — feat(11-03): scaffold Helm chart with replicaCount fail-guard (REL-03)
- 6a0236a — feat(11-03): add Helm templates with existingSecretName + pod security (REL-04, REL-05)
