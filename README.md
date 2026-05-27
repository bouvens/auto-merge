# auto-merge

Self-hostable GitHub App for automatic cascade merges: `main → release → dev`
(or `main → dev` when there is no release branch). Replaces the traditional shell
script + PAT token with a GitHub App that uses short-lived installation tokens,
records every action as a merge commit, Check Run, or Pull Request, and notifies
your team via Slack or Telegram the moment a conflict blocks the cascade.

## Quickstart

1. Pick your deployment platform from the decision matrix below.
2. Follow the corresponding install path (Compose + Caddy, Helm, or PaaS).
3. Point the GitHub App webhook URL at your deployed instance.

All three paths use the same container image and the same environment variables.
The choice is operational, not functional.

## Decision Matrix

| Where you run it | Install path | When |
|---|---|---|
| VPS / bare metal / single-host Linux | [Compose + Caddy](#install--path-a-compose--caddy) (`examples/compose/`) | You own a server with a public IP and a domain |
| Kubernetes (any flavor) | [Helm chart](#install--path-b-helm) (`deploy/helm/auto-merge/`) | You already operate k8s and want native Secret + Ingress integration |
| Managed PaaS | [Fly.io or Render.com](#install--path-c-paas-flyio--rendercom) (`examples/paas/`) | You want zero infrastructure ops and are willing to pay a small premium |

All three paths use the same image and the same env vars. The decision is operational, not
functional. None is recommended over the others.

## Install — Path A: Compose + Caddy

> **DNS-first warning:** Set your DNS `A` record to the server's public IP **before** running
> `docker compose up`. Caddy uses ACME HTTP-01 to obtain a Let's Encrypt certificate. If
> the domain does not resolve publicly when Caddy first starts, the HTTP-01 challenge fails.
> Repeated failures consume Let's Encrypt rate-limit budget (5 failures per hostname per
> hour). Use the staging overlay first to avoid burning the production limit.

The compose template lives in [`examples/compose/`](examples/compose/).

**Step 1 — Copy and populate the env file:**

```bash
cp examples/compose/.env.example .env
chmod 600 .env
```

Fill in these values in `.env`:

```
APP_ID=<your GitHub App ID>
WEBHOOK_SECRET=<generate with: openssl rand -hex 32>
PRIVATE_KEY=<raw PEM string, or base64-encoded PEM — both accepted>
DOMAIN=your.domain.com
ACME_EMAIL=you@example.com
```

`PRIVATE_KEY` accepts both raw PEM (`-----BEGIN RSA PRIVATE KEY-----…`) and a
base64-encoded PEM (useful when pasting multi-line keys into env files). See
[Configuration reference](#configuration-reference) for details.

**Step 2 — Validate with Let's Encrypt staging (avoids rate-limit burn):**

```bash
docker compose -f examples/compose/docker-compose.yml \
               -f examples/compose/compose.staging.yml \
               --env-file .env up -d
```

Check logs: `docker compose logs caddy`. Look for a successful certificate line.
Staging certificates produce a browser warning — that is expected.

**Step 3 — Switch to production:**

```bash
docker compose -f examples/compose/docker-compose.yml --env-file .env up -d
```

**Step 4 — Verify:**

```bash
curl https://your.domain.com/healthz
# → {"status":"ok"}
```

Point the GitHub App webhook URL at `https://your.domain.com/webhook`, then trigger
a test push to `main`.

> **Caddy data volume:** Never run `docker compose down -v` in production. The named
> `caddy_data` volume stores the Let's Encrypt certificate. Deleting it forces
> re-issuance and may hit the rate limit.

## Install — Path B: Helm

The Helm chart lives in [`deploy/helm/auto-merge/`](deploy/helm/auto-merge/).

> **Single replica only:** The chart enforces `replicaCount: 1` with a hard template
> guard. Setting `replicaCount > 1` causes `helm install/upgrade` to fail at render time.
> auto-merge uses in-memory cascade locks that are not safe for multi-replica deployments.

**Step 1 — Create a Kubernetes Secret with your credentials:**

```bash
kubectl create secret generic auto-merge-secrets \
  --from-literal=APP_ID=<your-app-id> \
  --from-literal=WEBHOOK_SECRET=<your-webhook-secret> \
  --from-literal=PRIVATE_KEY="$(cat ./app-key.pem)"
```

The secret name you choose here must match `existingSecretName` in Step 2.

**Step 2 — Install the chart:**

```bash
helm install auto-merge ./deploy/helm/auto-merge \
  --set existingSecretName=auto-merge-secrets \
  --set image.repository=ghcr.io/OWNER/auto-merge \
  --set image.tag=v1.1.0
```

Never put `PRIVATE_KEY` or other secrets in `values.yaml`. They would end up in
Helm release history (stored as cluster Secrets accessible to anyone with
`helm get values` access).

**Step 3 — Expose via Ingress:**

```bash
helm upgrade auto-merge ./deploy/helm/auto-merge \
  --set existingSecretName=auto-merge-secrets \
  --set image.repository=ghcr.io/OWNER/auto-merge \
  --set image.tag=v1.1.0 \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=your.domain.com \
  --set ingress.hosts[0].paths[0].path=/
```

Or override values in a local `values.override.yaml` and pass `--values` to keep
the command short.

**Step 4 — Verify:**

```bash
kubectl rollout status deployment/auto-merge
kubectl port-forward svc/auto-merge 8080:80
curl http://localhost:8080/healthz
# → {"status":"ok"}
```

Point the GitHub App webhook URL at the Ingress host.

## Install — Path C: PaaS (Fly.io / Render.com)

Both PaaS paths use the same container image. `PRIVATE_KEY` is passed as a
base64-encoded PEM string — the app decodes it transparently at boot.

```bash
# Encode once — do not double-encode
fly secrets set PRIVATE_KEY=$(cat ./app-key.pem | base64 | tr -d '\n')
```

Verify encoding: `printf '%s' "$PRIVATE_KEY" | base64 -d | head -c 27` should print
`-----BEGIN RSA PRIVATE KEY` (or `-----BEGIN PRIVATE KEY` for PKCS#8 format).

### Fly.io

Template: [`examples/paas/fly/`](examples/paas/fly/). Full step-by-step in
[`examples/paas/fly/README.md`](examples/paas/fly/README.md).

The `fly.toml` sets `auto_stop_machines = false` — webhook receivers must stay running.
Fly hibernates machines after inactivity by default; hibernated machines miss GitHub
webhook deliveries (GitHub retries for 5–30 minutes then stops).

### Render.com

Template: [`examples/paas/render/`](examples/paas/render/). Full step-by-step in
[`examples/paas/render/README.md`](examples/paas/render/README.md).

The `render.yaml` blueprint sets `sync: false` on `APP_ID`, `WEBHOOK_SECRET`, and
`PRIVATE_KEY` — Render will prompt you to fill these in the dashboard rather than
storing them in the blueprint file.

Pin a semver tag (`v1.1.0`) instead of `:latest` in the blueprint. Render re-pulls
on every redeploy; `:latest` causes silent drift.

## Verifying the Image Signature

Every release image is built by GitHub Actions and signed via cosign keyless OIDC.
The signature proves the image originated from this repository's CI workflow and was
not tampered with after build.

```bash
cosign verify ghcr.io/OWNER/auto-merge:v1.1.0 \
  --certificate-identity-regexp "https://github.com/OWNER/auto-merge/.*" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

Replace `OWNER` with your GitHub organization or username and `v1.1.0` with the tag
you are deploying.

The `--certificate-oidc-issuer` value is always `https://token.actions.githubusercontent.com`
for GitHub Actions keyless signing. The `--certificate-identity-regexp` anchors verification
to this repository's path — a differently-signed image from another repo would not pass.

For background on cosign keyless signing, see the
[Sigstore documentation](https://docs.sigstore.dev/cosign/signing/overview/).

## GitHub App Setup

1. Go to **GitHub Settings → Developer settings → GitHub Apps → New GitHub App**
   (personal: `https://github.com/settings/apps/new`;
   org: `https://github.com/organizations/<org>/settings/apps/new`).

2. Set the **Webhook URL** to `https://<your-host>/webhook`.

3. Set the **Webhook secret** (`openssl rand -hex 32`). Save this value — you pass it
   as `WEBHOOK_SECRET`.

4. Grant the following **Repository permissions** (all others: "No access"):

   | Permission | Level | Why |
   |---|---|---|
   | Contents | Read & write | Create merge commits on cascade branches |
   | Pull requests | Read & write | Open PRs when a merge conflict is detected |
   | Checks | Read & write | Post Check Runs for config validation and cascade status |
   | Metadata | Read | Required by GitHub for all Apps |
   | Administration | Read | Pre-flight check for branch protection rules |

5. Under **Subscribe to events**, enable: **Push**, **Repository dispatch**.

6. Click **Create GitHub App**. On the App settings page click **Generate a private key**,
   download the `.pem` file. Save the **App ID** shown under "About".

7. In the left sidebar click **Install App** and install it on the repositories the App
   should manage.

If `SETUP_ENABLED=true` is set, the `/setup/new` endpoint is available for one-click
App Manifest creation — set `SETUP_PUBLIC_URL` to the public URL of your instance.

## Per-Repo Config

Each repository managed by auto-merge must have a `.github/auto-merge.yml` file:

```yaml
main_branch: main
release_branch: release   # optional — omit for a two-branch main → dev cascade
dev_branch: dev
notifications:
  slack:
    channel: "#auto-merge-ops"   # overrides the default channel from SLACK_WEBHOOK_URL
  telegram:
    chat_id: "-1001234567890"    # overrides the default chat from TELEGRAM_BOT_TOKEN
```

The `notifications` block is optional. When absent, notifications go to the default
channel/chat set by env vars.

Config is validated on every push. An invalid config produces a `failure` Check Run
and (if notify is configured) a `config_invalid` notification.

**Cascade config precedence (lowest → highest):** `DEFAULT_CASCADE_CONFIG_YAML` env var →
`DEFAULT_CASCADE_CONFIG_FILE` path → per-repo `.github/auto-merge.yml`. The repo-level
file always wins when present.

## Slack Setup

1. Go to `https://api.slack.com/apps` → **Create New App → From scratch**.
2. Under **Features → Incoming Webhooks**, toggle on → **Add New Webhook to Workspace**.
3. Select the notification channel and click **Allow**.
4. Copy the webhook URL (`https://hooks.slack.com/services/T.../B.../…`).
5. Set `SLACK_WEBHOOK_URL=<url>` in your container environment.

## Telegram Setup

1. DM **@BotFather** and send `/newbot`. Follow the prompts.
2. Copy the bot token (format: `1234567890:ABCDEF…`).
3. Set `TELEGRAM_BOT_TOKEN=<token>` and `TELEGRAM_DEFAULT_CHAT_ID=<chat_id>`.
4. To find your `chat_id`: add the bot to the target group, send a message, then call
   `https://api.telegram.org/bot<token>/getUpdates` — the `chat.id` field is the value
   you need.

## Manual Trigger

Use `workflow_dispatch` when you want to force a cascade without pushing a new commit.
Add this workflow to each managed repository:

```yaml
# .github/workflows/auto-merge.yml
name: auto-merge trigger
on:
  workflow_dispatch:
permissions:
  contents: write
jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - name: dispatch auto-merge
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh api repos/${{ github.repository }}/dispatches \
            -F event_type=auto-merge
```

No PAT required. The built-in `GITHUB_TOKEN` with `contents: write` is sufficient.

## Configuration Reference

**Cascade config precedence (lowest → highest):**
`DEFAULT_CASCADE_CONFIG_YAML` → `DEFAULT_CASCADE_CONFIG_FILE` → per-repo `.github/auto-merge.yml`.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `APP_ID` | yes | — | GitHub App ID (integer from App settings "About") |
| `WEBHOOK_SECRET` | yes | — | Minimum 16 characters; used for HMAC webhook signature verification |
| `PRIVATE_KEY` | one of two | — | Raw PEM string **or** base64-encoded PEM — both accepted; the app decodes base64 at boot |
| `PRIVATE_KEY_PATH` | one of two | — | Path to a `.pem` file; also accepts base64-encoded PEM inside the file |
| `PORT` | no | `3000` | HTTP listen port |
| `LOG_LEVEL` | no | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` |
| `WEBHOOK_QUEUE_MAX` | no | `1000` | Global cap on concurrent webhook jobs (drop-oldest beyond this) |
| `WEBHOOK_QUEUE_PER_KEY_MAX` | no | `16` | Per-repo queue cap |
| `SHUTDOWN_TIMEOUT` | no | `30000` | Milliseconds to wait for in-flight cascades on SIGTERM |
| `CRON_SCHEDULE` | no | `*/10 * * * *` | Safety-net sweep cron expression; set to `""` to disable |
| `CRON_TZ` | no | `UTC` | Timezone for cron expression evaluation |
| `SLACK_WEBHOOK_URL` | no | — | Incoming webhook URL for Slack notifications |
| `TELEGRAM_BOT_TOKEN` | no | — | Telegram bot token (min 40 chars) |
| `TELEGRAM_DEFAULT_CHAT_ID` | no | — | Default Telegram chat/group ID for notifications |
| `NOTIFY_HEALTHCHECK_REQUIRED` | no | `false` | Require a healthcheck ping before marking a cascade done (v1.1) |
| `NOTIFY_HEALTHCHECK_TTL_MS` | no | `900000` | Healthcheck freshness window in milliseconds (15 min) |
| `SETUP_ENABLED` | no | `false` | Enable the `/setup/new` App Manifest endpoint |
| `SETUP_PUBLIC_URL` | no | — | Required when `SETUP_ENABLED=true`; public URL of this instance |
| `SETUP_APP_NAME` | no | `auto-merge` | Default name suggested in the App Manifest (max 34 chars) |
| `SETUP_OUTPUT_DIR` | no | `./data` | Directory where setup writes the generated App credentials |
| `DEFAULT_CASCADE_CONFIG_FILE` | no | — | Path to a fallback cascade config YAML file |
| `DEFAULT_CASCADE_CONFIG_YAML` | no | — | Inline fallback cascade config as a YAML string |
| `DEFAULT_CONFIG_RELOAD_MS` | no | `60000` | Interval in milliseconds to reload the default cascade config |
| `DIAGNOSE_TOKEN` | no | — | Bearer token enabling the `GET /diagnose/{owner}/{repo}` endpoint |
| `NOTIFY_DEDUP_TTL_MS` | no | `3600000` | Notification dedup window in milliseconds (1 hour) |
| `NOTIFY_DEDUP_MAX` | no | `1000` | Maximum dedup cache entries before LRU eviction |
| `NOTIFY_TIMEOUT_MS` | no | `5000` | Per-attempt timeout for Slack/Telegram HTTP requests |
| `NOTIFY_RETRY_ATTEMPTS` | no | `3` | Retry count before marking a notification as final-fail |
| `NODE_ENV` | no | `production` | `development` \| `production` \| `test` |

## Troubleshooting

### App installed but no cascades happen

Call the diagnose endpoint to inspect the app's view of a specific repository:

```bash
curl -H "Authorization: Bearer $DIAGNOSE_TOKEN" \
  https://your.domain.com/diagnose/OWNER/REPO
```

The response includes:

- `app_installed` — whether the App is installed on the repository
- `app_permissions` — which permissions the installation has
- `config_loaded` — whether `.github/auto-merge.yml` was found and parsed
- `branches_exist` — whether the configured cascade branches exist
- `branch_protection_status` — branch protection rules that may block merges
- `notify_credentials_status` — Slack/Telegram credential presence (never raw values)

Set `DIAGNOSE_TOKEN` to any string of at least 16 characters to enable the endpoint.
The endpoint never returns raw secrets — Slack webhook URLs are redacted to
`https://hooks.slack.com/services/T.../B.../****` and tokens are reported as
`present/absent` plus byte length only.

### Boot fails with `env-invalid`

The app validates all env vars at startup via zod and exits with `env-invalid` if
validation fails. Common causes:

- `APP_ID` not set or not a positive integer
- `WEBHOOK_SECRET` shorter than 16 characters
- Neither `PRIVATE_KEY` nor `PRIVATE_KEY_PATH` is set (exactly one is required)
- Both `PRIVATE_KEY` and `PRIVATE_KEY_PATH` are set (only one is allowed)
- `SETUP_ENABLED=true` without `SETUP_PUBLIC_URL`

### `createPrivateKey` fails / `no start line`

The private key was encoded more than once. Encode the PEM **exactly once**:

```bash
# Correct — encode once
fly secrets set PRIVATE_KEY=$(cat ./app-key.pem | base64 | tr -d '\n')

# Wrong — double-encoded
fly secrets set PRIVATE_KEY=$(cat ./app-key.pem | base64 | base64)
```

Verify: `printf '%s' "$PRIVATE_KEY" | base64 -d | head -c 27` should print
`-----BEGIN RSA PRIVATE KEY` (or `-----BEGIN PRIVATE KEY`). If it prints binary
garbage, the value is double-encoded.

### Caddy Let's Encrypt rate limit

Caddy stores certificates in the `caddy_data` named volume. If the volume is deleted
(for example via `docker compose down -v`), Caddy re-requests a certificate on next
start. Repeated re-requests burn the Let's Encrypt
[rate limit](https://letsencrypt.org/docs/rate-limits/) (5 certificates per domain
per week for duplicate issuance).

Use the staging overlay (`compose.staging.yml`) when validating a new deployment.
Never run `docker compose down -v` in production unless you intend to re-issue certificates.

## Architecture — Cascade Flow

```mermaid
flowchart TD
    A[Push to main] --> B{Webhook received}
    B --> C[Cascade: merge main → release]
    C --> D{Conflict?}
    D -- No --> E[Cascade: merge release → dev]
    E --> F{Conflict?}
    F -- No --> G[Done ✓]
    D -- Yes --> H[Open conflict PR]
    F -- Yes --> H
    H --> I[Notify Slack / Telegram]
    I --> J[Human resolves]
    J --> A
```

For a two-branch cascade (`main → dev`) the release node is skipped. The safety-net
cron (`CRON_SCHEDULE`) re-runs the same flow periodically to catch any pushes the
webhook missed.

## Health Endpoints

| Endpoint | Type | Response |
|---|---|---|
| `GET /healthz` | Liveness | `{"status":"ok"}` — 200 while the event loop is alive |
| `GET /readyz` | Readiness | `{"status":"ready"}` — 200 when the GitHub App JWT can be minted from the private key |

## Graceful Shutdown

On `SIGTERM` or `SIGINT` the app executes this sequence:

| Step | Action | Budget |
|---|---|---|
| 1 | Stop the cron scheduler | up to 5 s |
| 2 | Stop accepting new HTTP requests | ~instant |
| 3 | Drain per-repo queues | up to `SHUTDOWN_TIMEOUT` (default 30 s) |
| 4 | `exit 0` | — |

Set `--stop-timeout=60` (Docker) or `terminationGracePeriodSeconds: 60` (Kubernetes) so
the runtime waits long enough before sending SIGKILL.

## Local Development

```bash
npm install
cp .env.example .env   # populate APP_ID, WEBHOOK_SECRET, PRIVATE_KEY_PATH
npm run dev
```

**Webhook tunneling (dev only):**

```bash
npx smee-client --url https://smee.io/<channel> --target http://localhost:3000/webhook
```

| Script | Command | Purpose |
|---|---|---|
| `build` | `tsc --project tsconfig.build.json` | Compile TypeScript to `dist/` |
| `dev` | `tsx watch src/index.ts` | Dev server with hot-reload |
| `start` | `node --enable-source-maps dist/index.js` | Run compiled output |
| `test` | `vitest run` | Run tests once |
| `lint:fix` | `biome check --write .` | Lint and auto-format |
| `typecheck` | `tsc --noEmit` | Type-check without emitting |

## Contributing

Pull requests welcome. Open an issue first for significant changes.

## License

[MIT](LICENSE)
