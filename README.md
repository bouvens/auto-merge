# auto-merge

Self-hostable GitHub App for automatic cascade merging: `main → release → dev` (or `main → dev` when no release branch exists).

Replaces PAT-based scripts with a GitHub App using minimal permissions, an audit trail via Check Runs and merge commits, and conflict notifications via Slack/Telegram.

## Status

Phase 1 (Foundation) — webhook receiver + health endpoints operational. Cascade merge engine is not yet implemented (Phase 2+).

## Prerequisites

- Node.js 22+ for local development
- Docker for self-hosting
- A registered GitHub App (see [GitHub App Setup](#github-app-setup) below)

## GitHub App Setup

Create a GitHub App at `https://github.com/settings/apps/new` (personal) or `https://github.com/organizations/<org>/settings/apps/new` (org).

**Required permissions (minimum):**

| Permission | Level | Why |
|---|---|---|
| Contents | Read & write | Create merge commits on cascade branches |
| Pull requests | Read & write | Open PRs when a merge conflict is detected |
| Checks | Read & write | Post Check Runs for config validation and cascade status |
| Metadata | Read | Read repository metadata (required by GitHub) |

**Events to subscribe (Phase 1+):** `ping`, `installation`, `installation_repositories`, `installation_target`

**Events needed for future phases:** `push`, `repository_dispatch` (subscribe now to avoid re-registering later)

**Webhook URL:** `https://<your-host>/webhook`

**Webhook secret:** Generate with `openssl rand -hex 32`. Save the value — you will pass it as `WEBHOOK_SECRET`.

**Private key:** In the App settings page, generate a private key and download the `.pem` file.

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `APP_ID` | GitHub App ID (integer shown in App settings → About) |
| `WEBHOOK_SECRET` | Webhook secret you set during App creation (min 16 chars) |
| `PRIVATE_KEY_PATH` | Path to the mounted `.pem` private key file **(recommended for production)** |
| `PRIVATE_KEY` | Inline PEM string with literal `\n` newlines **(alternative for quick-start)** |

Exactly one of `PRIVATE_KEY_PATH` or `PRIVATE_KEY` must be provided.

### Optional

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `LOG_LEVEL` | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` |
| `WEBHOOK_QUEUE_MAX` | `1000` | Max in-flight webhook jobs before oldest is dropped |
| `SHUTDOWN_TIMEOUT` | `30000` | Milliseconds to wait for in-flight jobs on SIGTERM |
| `NODE_ENV` | `production` | `development` \| `production` \| `test` |
| `SLACK_WEBHOOK_URL` | — | Slack incoming webhook URL for conflict notifications (Phase 4) |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token for conflict notifications (Phase 4) |

## Quick Start (Docker)

### Recommended: private key as a mounted file (production)

```bash
docker run -d \
  -p 3000:3000 \
  -e APP_ID=12345 \
  -e WEBHOOK_SECRET=$(openssl rand -hex 32) \
  -e PRIVATE_KEY_PATH=/run/secrets/app-key.pem \
  -v /path/to/app-key.pem:/run/secrets/app-key.pem:ro \
  --name auto-merge \
  ghcr.io/<your-org>/auto-merge:latest
```

### Alternative: inline private key (quick-start / CI)

```bash
docker run --rm \
  -p 3000:3000 \
  -e APP_ID=12345 \
  -e WEBHOOK_SECRET=$(openssl rand -hex 32) \
  -e PRIVATE_KEY="$(cat app-key.pem)" \
  ghcr.io/<your-org>/auto-merge:latest
```

### Build from source

```bash
docker build -t auto-merge:local .
docker run --rm -p 3000:3000 \
  -e APP_ID=12345 \
  -e WEBHOOK_SECRET=<secret> \
  -e PRIVATE_KEY_PATH=/run/secrets/app-key.pem \
  -v "$PWD/app-key.pem:/run/secrets/app-key.pem:ro" \
  auto-merge:local
```

## Health Endpoints

| Endpoint | Type | Returns |
|---|---|---|
| `GET /healthz` | Liveness | `{"status":"ok"}` — 200 while the event loop is alive |
| `GET /readyz` | Readiness | `{"status":"ready"}` — 200 when the GitHub App JWT can be minted from the private key |

## Local Development

```bash
npm install
cp .env.example .env   # populate APP_ID, WEBHOOK_SECRET, PRIVATE_KEY_PATH
node --env-file=.env --import tsx src/index.ts
# or
npm run dev
```

**Webhook tunneling with smee.io (dev only):**

```bash
npx smee-client --url https://smee.io/<your-channel> --target http://localhost:3000/webhook
```

Set the smee.io URL as the Webhook URL in your GitHub App settings.

## Scripts

| Script | Command | Purpose |
|---|---|---|
| `build` | `tsc --project tsconfig.build.json` | Compile TypeScript to `dist/` |
| `dev` | `tsx watch src/index.ts` | Dev server with hot-reload |
| `start` | `node --enable-source-maps dist/index.js` | Run compiled output |
| `test` | `vitest run` | Run tests once |
| `test:watch` | `vitest` | Run tests in watch mode |
| `lint:fix` | `biome check --write .` | Lint and auto-format |
| `typecheck` | `tsc --noEmit` | Type-check without emitting |

## What Is Not in Phase 1

The following features land in later phases:

- **Phase 2:** Cascade merge engine (`main → release → dev`)
- **Phase 3:** Per-repository lock manager and cron safety-net
- **Phase 4:** Slack and Telegram conflict notifications

## Manual Trigger via workflow_dispatch

Use this when webhooks are delayed or you want to force a cascade on the current `main` HEAD without pushing a new commit.

Commit the following workflow to each repository managed by auto-merge:

```yaml
# .github/workflows/auto-merge.yml
name: auto-merge trigger
on:
  workflow_dispatch:
permissions:
  contents: write           # required by POST /repos/{owner}/{repo}/dispatches
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

**Notes:**

- No PAT required. The built-in `GITHUB_TOKEN` with `permissions: contents: write` is sufficient to call `POST /repos/{owner}/{repo}/dispatches`.
- The App always resolves the cascade source from `config.main_branch` HEAD at the time the event is processed. The `client_payload` field is logged for audit but does not influence routing.
- You may pass additional context via `-F 'client_payload[note]=manual run'`; it appears in structured logs but is otherwise ignored.
- **GitHub App settings:** ensure `repository_dispatch` is checked under "Subscribe to events" in your App's configuration. Without this subscription the App will not receive the webhook.
- To avoid a cascade loop, do not wire both `on: push` and the `gh api dispatches` call in the same workflow triggered by a push to `main`. The App itself never calls `POST /dispatches`, so there is no recursion from its side.
