# auto-merge

## What & Why

Engineering teams that maintain a long-lived branch cascade (`main → release → dev`) spend
time manually merging upstream changes downstream after every release commit. The typical
workaround — a shell script authenticated with a Personal Access Token — accumulates
unrotated tokens in repository secrets, carries broader permissions than needed, and leaves
no audit trail when a merge fires.

auto-merge replaces that script with a self-hosted GitHub App. The App uses an installation
token minted on demand (short-lived, scoped to the target repos), records every action as a
merge commit, Check Run, or Pull Request, and notifies your team via Slack or Telegram the
moment a conflict blocks the cascade. All you need is a VPS or k8s pod running one Docker
container.

## Quickstart

```bash
docker run -d \
  -e APP_ID=123456 \
  -e PRIVATE_KEY="$(cat ./private-key.pem)" \
  -e WEBHOOK_SECRET=$(openssl rand -hex 32) \
  -p 3000:3000 \
  ghcr.io/bouvens/auto-merge:1.0
```

For production use the file-mount approach (see [GitHub App Setup](#github-app-setup)):

```bash
docker run -d \
  -e APP_ID=123456 \
  -e WEBHOOK_SECRET=$(openssl rand -hex 32) \
  -e PRIVATE_KEY_PATH=/run/secrets/app-key.pem \
  -v /path/to/app-key.pem:/run/secrets/app-key.pem:ro \
  -p 3000:3000 \
  --stop-timeout=60 \
  ghcr.io/bouvens/auto-merge:1.0
```

`--stop-timeout=60` gives the container enough time to drain in-flight cascades on SIGTERM
before Docker sends SIGKILL (see [Graceful Shutdown](#graceful-shutdown)).

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `APP_ID` | GitHub App ID (integer shown in App settings under "About") |
| `WEBHOOK_SECRET` | Webhook secret set during App creation (minimum 16 characters) |
| `PRIVATE_KEY_PATH` | Path to the mounted `.pem` private key file **(recommended for production)** |
| `PRIVATE_KEY` | Inline PEM string with literal `\n` newlines **(alternative, useful in CI)** |

Exactly one of `PRIVATE_KEY_PATH` or `PRIVATE_KEY` must be provided.

### Optional

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `LOG_LEVEL` | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` |
| `WEBHOOK_QUEUE_MAX` | `1000` | Global cap on in-flight webhook jobs (drop-oldest beyond this) |
| `WEBHOOK_QUEUE_PER_KEY_MAX` | `16` | Per-repo queue cap (drop-oldest beyond this) |
| `SHUTDOWN_TIMEOUT` | `30000` | Milliseconds to wait for in-flight cascades on SIGTERM |
| `CRON_SCHEDULE` | `*/10 * * * *` | Cron expression for the safety-net sweep; set to empty string to disable |
| `CRON_TZ` | `UTC` | Timezone for cron expression evaluation |
| `SLACK_WEBHOOK_URL` | — | Slack incoming webhook URL for conflict and error notifications |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token for conflict and error notifications |
| `NOTIFY_DEDUP_TTL_MS` | `3600000` | Dedup window in milliseconds (default 1 hour) |
| `NOTIFY_DEDUP_MAX` | `1000` | Maximum dedup cache entries before eviction |
| `NOTIFY_TIMEOUT_MS` | `5000` | Per-attempt timeout for Slack/Telegram HTTP requests |
| `NOTIFY_RETRY_ATTEMPTS` | `3` | Number of retry attempts before marking a notification as final-fail |
| `NODE_ENV` | `production` | `development` \| `production` \| `test` |

## GitHub App Setup

1. Go to **GitHub Settings → Developer settings → GitHub Apps → New GitHub App**
   (personal: `https://github.com/settings/apps/new`;
   org: `https://github.com/organizations/<org>/settings/apps/new`).

2. Set the **Webhook URL** to `https://<your-host>/webhook`.

3. Set the **Webhook secret** (generate with `openssl rand -hex 32`). Save the value — you
   will pass it as `WEBHOOK_SECRET`.

4. Grant the following **Repository permissions** (all others can stay "No access"):

   | Permission | Level | Why |
   |---|---|---|
   | Contents | Read & write | Create merge commits on cascade branches |
   | Pull requests | Read & write | Open PRs when a merge conflict is detected |
   | Checks | Read & write | Post Check Runs for config validation and cascade status |
   | Metadata | Read | Required by GitHub for all Apps |
   | Administration | Read | Pre-flight check for branch protection rules |

5. Under **Subscribe to events**, enable: **Push**, **Repository dispatch**.

6. Click **Create GitHub App**. On the App settings page click **Generate a private key**,
   download the `.pem` file. Save the **App ID** shown in "About".

7. In the left sidebar click **Install App** and install it on the repositories the App
   should manage.

## Slack Setup

1. Go to `https://api.slack.com/apps` and click **Create New App → From scratch**.
2. Under **Features → Incoming Webhooks**, toggle it on and click **Add New Webhook to Workspace**.
3. Select the channel where notifications should be posted and click **Allow**.
4. Copy the webhook URL (looks like `https://hooks.slack.com/services/T.../B.../...`).
5. Set `SLACK_WEBHOOK_URL=<url>` in your container environment.

To send notifications to a different channel per repository, override it in
`.github/auto-merge.yml` (see [Per-Repo Config](#per-repo-config)):

```yaml
notifications:
  slack:
    channel: "#team-alerts"
```

## Telegram Setup

1. DM **@BotFather** on Telegram and send `/newbot`. Follow the prompts.
2. Copy the bot token (format: `1234567890:ABCDEF...`).
3. Set `TELEGRAM_BOT_TOKEN=<token>` in your container environment.
4. To get your `chat_id`: add the bot to a group (or use it in a direct chat), send any
   message, then call `https://api.telegram.org/bot<token>/getUpdates` — the `chat.id`
   field is the value you need. Alternatively, DM **@userinfobot** from that chat.

To send notifications to a different chat per repository, override it in
`.github/auto-merge.yml`:

```yaml
notifications:
  telegram:
    chat_id: "-1001234567890"
```

## Per-Repo Config

Each repository managed by auto-merge must have a `.github/auto-merge.yml` file:

```yaml
main_branch: main
release_branch: release   # optional — omit for a two-branch main -> dev cascade
dev_branch: dev
notifications:
  slack:
    channel: "#auto-merge-ops"   # overrides SLACK_WEBHOOK_URL target channel
  telegram:
    chat_id: "-1001234567890"    # overrides TELEGRAM_BOT_TOKEN target chat
```

The `notifications` block is optional. When absent, notifications are sent to the default
channel/chat configured via env vars. When present, the `channel` / `chat_id` values
override the default destination for that repository only.

The file is validated against a strict schema on every push. An invalid config produces a
`failure` Check Run on the `push` event and (if notify is configured) triggers a
`config_invalid` notification.

## Manual Trigger via workflow_dispatch

Use this when webhooks are delayed or you want to force a cascade on the current `main` HEAD
without pushing a new commit.

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

Notes:

- No PAT required. The built-in `GITHUB_TOKEN` with `permissions: contents: write` is
  sufficient to call `POST /repos/{owner}/{repo}/dispatches`.
- The App resolves the cascade source from `config.main_branch` HEAD at the time the event
  is processed. The `client_payload` field is logged for audit but does not influence routing.
- You may pass additional context via `-F 'client_payload[note]=manual run'`; it appears in
  structured logs but is otherwise ignored.
- Ensure `repository_dispatch` is checked under "Subscribe to events" in the GitHub App
  settings.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `notify_delivery_failed channel=slack final_status=404` | Slack channel not found | Check `notifications.slack.channel` in `.github/auto-merge.yml` matches a real channel name or ID in the workspace. |
| `notify_delivery_failed channel=telegram final_status=400 description=chat not found` | Wrong Telegram `chat_id` | Send a message to the bot, call `getUpdates` to see the actual `chat.id`, update `.github/auto-merge.yml`. |
| Check Run "Invalid .github/auto-merge.yml" | Config file missing required fields | Verify your file matches the example in [Per-Repo Config](#per-repo-config). All three branch fields are required. |
| Check Run `permission_error: App lacks contents: write` | GitHub App missing permissions | Go to App settings → Permissions & events, grant the missing permission, then re-install the App on the affected repositories. |
| Container stops before queue drains on deploy | SIGKILL arrives before SIGTERM budget expires | Pass `--stop-timeout=60` to `docker run`, or set `terminationGracePeriodSeconds: 60` in the Kubernetes pod spec. |
| `/readyz` returns 503 on startup | Private key cannot be parsed | Verify the file at `PRIVATE_KEY_PATH` is the `.pem` downloaded from the GitHub App settings page. Inline `PRIVATE_KEY` must preserve literal `\n` newlines. |

## Health Endpoints

| Endpoint | Type | Returns |
|---|---|---|
| `GET /healthz` | Liveness | `{"status":"ok"}` — 200 while the event loop is alive |
| `GET /readyz` | Readiness | `{"status":"ready"}` — 200 when the GitHub App JWT can be minted from the private key |

## Graceful Shutdown

On `SIGTERM` or `SIGINT` the App executes this shutdown sequence:

| Step | Action | Budget |
|---|---|---|
| 1 | Stop the cron scheduler (waits for any running tick to finish) | up to 5 s |
| 2 | Stop accepting new HTTP requests (Fastify close) | ~instant |
| 3 | Drain per-repo queues — wait for in-flight cascades to finish | up to `SHUTDOWN_TIMEOUT` (default 30 s) |
| 4 | `exit 0` | — |

Total time before the process exits: **up to `SHUTDOWN_TIMEOUT` + 5 s** (up to 35 s with defaults).

If in-flight cascades are still running when the timeout expires, the App logs
`multi_queue_drain_timeout` and exits 0. The next cron tick picks up any missed work.

**SIGKILL cannot be caught.** A hard kill drops all in-flight cascades immediately. The next
cron tick recovers missed work. Server-side merges are atomic — the commit either landed or
it did not.

**Container grace period:** set `--stop-timeout=60` (Docker) or
`terminationGracePeriodSeconds: 60` (Kubernetes) so the runtime waits long enough for the
shutdown sequence before sending SIGKILL.

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

Set the smee.io URL as the Webhook URL in your GitHub App settings for local testing.

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

## Build from Source

```bash
docker build -t auto-merge:local .
docker run -d \
  -e APP_ID=123456 \
  -e WEBHOOK_SECRET=$(openssl rand -hex 32) \
  -e PRIVATE_KEY_PATH=/run/secrets/app-key.pem \
  -v "$PWD/app-key.pem:/run/secrets/app-key.pem:ro" \
  -p 3000:3000 \
  --stop-timeout=60 \
  auto-merge:local
```
