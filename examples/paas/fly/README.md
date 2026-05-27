# Deploy auto-merge on Fly.io

This guide deploys the pre-built GHCR image to Fly.io without rebuilding from source.
`fly.toml` sets `auto_stop_machines = false` so machines stay running and never miss a
webhook delivery (Fly hibernates idle machines by default — see Troubleshooting below).

## Prerequisites

- [flyctl](https://fly.io/docs/hands-on/install-flyctl/) installed and authenticated (`fly auth login`)
- A Fly.io account
- A GitHub App created and its credentials on hand:
  - **App ID** — visible on the GitHub App settings page
  - **Private key** — downloaded `.pem` file
  - **Webhook secret** — a random string you chose when creating the App

## Step 1 — Create the Fly app

```bash
fly apps create auto-merge   # or any globally unique slug
```

If you choose a different slug, update the `app =` line in `fly.toml` to match.

## Step 2 — Set secrets

Secrets are stored encrypted by Fly and injected as env vars at container start.

```bash
# GitHub App credentials
fly secrets set APP_ID=<your-numeric-app-id>

fly secrets set WEBHOOK_SECRET=$(openssl rand -hex 32)

# Encode the private key as base64 to avoid multi-line shell escaping issues.
# auto-merge decodes base64-PEM transparently at boot (REL-08 — decodeMaybeBase64Pem
# in src/env.ts detects "-----BEGIN" and falls back to raw PEM if the value is not base64).
fly secrets set PRIVATE_KEY="$(cat ./app-key.pem | base64 | tr -d '\n')"

# Optional: notification channels
# fly secrets set SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
# fly secrets set TELEGRAM_BOT_TOKEN=<token>
# fly secrets set TELEGRAM_DEFAULT_CHAT_ID=<chat-id>

# Optional: /diagnose endpoint bearer token (omit to disable the endpoint)
# fly secrets set DIAGNOSE_TOKEN=$(openssl rand -hex 32)
```

## Step 3 — Verify the image signature (recommended)

Before deploying, verify the image was built by the official release workflow:

```bash
cosign verify ghcr.io/OWNER/auto-merge:v1.1.0 \
  --certificate-identity-regexp "https://github.com/OWNER/auto-merge/.*" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

Replace `OWNER` with the GitHub user or org that hosts the repo.
See the main README for full supply-chain verification details.

## Step 4 — Deploy

```bash
flyctl deploy --image ghcr.io/OWNER/auto-merge:v1.1.0 --config examples/paas/fly/fly.toml
```

Replace `OWNER` and the tag with the actual values. The first deploy takes ~2 minutes.

## Step 5 — Update the GitHub App webhook URL

In your GitHub App settings, set the **Webhook URL** to:

```
https://<your-app>.fly.dev
```

Fly assigns the subdomain `<app-slug>.fly.dev` automatically.

## Step 6 — Verify

```bash
# Health check should return 200
curl -s https://<your-app>.fly.dev/healthz

# Tail live logs
flyctl logs

# Full diagnostics (requires DIAGNOSE_TOKEN)
curl -s -H "Authorization: Bearer <DIAGNOSE_TOKEN>" https://<your-app>.fly.dev/diagnose | jq
```

---

## Troubleshooting

### Machine hibernation — missed webhooks

`auto_stop_machines = false` in `fly.toml` prevents hibernation. If you change this to `true`
(or deploy a hand-edited config without it), Fly will stop the machine after inactivity.
GitHub retries failed webhook deliveries for only 5–30 minutes, then gives up. The cascade
appears to work but silently skips pushes that arrived while the machine was stopped.

**Fix:** Keep `auto_stop_machines = false`. The idle cost is negligible.

### Multi-line PRIVATE_KEY

Fly secrets are set via CLI arguments. Passing a raw multi-line PEM string in a shell
command requires quoting that is error-prone across shells (bash vs. zsh vs. fish differ).

**Fix:** Encode the key as base64 before setting it:

```bash
fly secrets set PRIVATE_KEY="$(cat ./app-key.pem | base64 | tr -d '\n')"
```

auto-merge detects the base64 encoding at boot and decodes it transparently.
Do **not** encode twice — double-encoding causes `no start line` errors in Probot.

### Private GHCR image

If your fork of auto-merge lives in a **private** GitHub repository, the GHCR image is
also private and Fly needs credentials to pull it.

Set the registry credentials before deploying:

```bash
fly secrets set FLY_REGISTRY_USER=<github-username>
fly secrets set FLY_REGISTRY_PASSWORD=<github-pat-with-read:packages>
```

Public repositories do not require this step.

---

## Cost note

`shared-cpu-1x` + `256mb` with `auto_stop_machines = false` costs roughly **$2–4/month**
at Fly.io's current rates (check [fly.io/docs/about/pricing](https://fly.io/docs/about/pricing/)
for current figures). This is the trade-off for reliable webhook delivery — a stopped machine
misses webhooks, a running one does not.
