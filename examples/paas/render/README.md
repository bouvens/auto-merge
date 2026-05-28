# Deploy auto-merge on Render.com

This guide deploys the pre-built GHCR image via a Render Blueprint (`render.yaml`).
Secrets are entered in the Render dashboard and are never stored in the blueprint file.

## Prerequisites

- A [Render](https://render.com) account
- A GitHub App created and its credentials on hand:
  - **App ID** — visible on the GitHub App settings page
  - **Private key** — downloaded `.pem` file
  - **Webhook secret** — a random string you chose when creating the App

## Step 1 — Create a new Blueprint

In the Render dashboard, go to **Blueprints → New Blueprint Instance** and connect this
repository (or paste the contents of `render.yaml` into a new service definition).

Alternatively, click the **Deploy to Render** button if it is available in the main README.

## Step 2 — Set environment variables

The `render.yaml` file lists secrets with `sync: false` — Render will prompt you to
enter each value in the dashboard before the first deploy. Fill in:

| Variable | Value |
|---|---|
| `APP_ID` | Numeric ID from your GitHub App settings page |
| `WEBHOOK_SECRET` | Output of `openssl rand -hex 32` |
| `PRIVATE_KEY` | Base64-encoded PEM — see below |
| `SLACK_WEBHOOK_URL` | (optional) Slack incoming webhook URL |
| `TELEGRAM_BOT_TOKEN` | (optional) Telegram bot token |
| `DIAGNOSE_TOKEN` | (optional) Bearer token for `/diagnose` endpoint |

### Encoding PRIVATE_KEY

Render's dashboard accepts single-line values. Encode the PEM key as base64 to avoid
multi-line input issues:

```bash
cat app-key.pem | base64 | tr -d '\n'
```

Paste the resulting single-line string into the `PRIVATE_KEY` field.
auto-merge detects the base64 encoding at boot and decodes it transparently
(REL-08 — `decodeMaybeBase64Pem` in `src/env.ts`). Do **not** encode twice —
double-encoding causes `no start line` errors in Probot.

## Step 3 — Verify the image signature (recommended)

Before applying the Blueprint, verify the image was built by the official release workflow:

```bash
cosign verify ghcr.io/OWNER/auto-merge:1.1.0 \
  --certificate-identity-regexp "https://github.com/OWNER/auto-merge/.*" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

Replace `OWNER` and the tag with the actual values.
See the main README for full supply-chain verification details.

## Step 4 — Apply the Blueprint

Click **Apply** in the Render dashboard. The first deploy pulls the image and starts
the service — this typically takes 3–5 minutes.

## Step 5 — Update the GitHub App webhook URL

In your GitHub App settings, set the **Webhook URL** to the Render-assigned subdomain:

```
https://<your-service-name>.onrender.com
```

The subdomain is shown on the service overview page in Render.

## Step 6 — Verify

```bash
# Health check should return 200
curl -s https://<your-service>.onrender.com/healthz

# Full diagnostics (requires DIAGNOSE_TOKEN)
curl -s -H "Authorization: Bearer <DIAGNOSE_TOKEN>" \
  https://<your-service>.onrender.com/diagnose | jq
```

---

## Troubleshooting

### Private GHCR image

If your fork of auto-merge lives in a **private** GitHub repository, the GHCR image is
also private. Render requires a `registryCredential` block in the Blueprint to pull
private images — see
[Render docs: Deploying a Private Image](https://render.com/docs/deploying-an-image#private-registry).

Public repositories (the default for upstream auto-merge) do not require this step.

### Image tag drift

`autoDeploy: false` prevents Render from re-pulling the image tag on its own schedule.
To upgrade to a new version:

1. Cosign-verify the new image tag.
2. Update the `url:` field in `render.yaml` and open a PR.
3. After merge, trigger a manual deploy in the Render dashboard.

Avoid using `:latest` — it makes rollbacks ambiguous and can pull an unverified image.

### cosign verify fails

Ensure you are verifying against the correct OIDC issuer
(`https://token.actions.githubusercontent.com`) and that the
`--certificate-identity-regexp` matches the exact repository path.

---

## Cost note

The `starter` plan costs approximately **$7/month** at time of writing.
Check [Render pricing](https://render.com/pricing) for current rates.
Use `free` plan only for staging — the free plan sleeps on inactivity and will miss webhooks.
