# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-05-22

### Added

- GitHub App cascade engine: automatic merge of main -> [release] -> dev via REST Merges API
- Per-repo configuration via `.github/auto-merge.yml` with zod schema validation
- Loop prevention: triple check (bot identity, email, commit trailer)
- Conflict handling: creates `auto-merge/conflict-*` branch + PR with `@author` mention
- Check Run lifecycle per merge attempt (in_progress -> success/failure/skipped)
- Per-(installation, repo) FIFO mutex preventing concurrent cascade races
- Branch protection pre-flight: detects blocking rules before merge attempt
- Permission-error mapping: actionable Check Run message per missing GitHub App permission
- Cron safety-net trigger (configurable via CRON_SCHEDULE env)
- `repository_dispatch` manual trigger via workflow_dispatch round-trip
- Graceful shutdown: SIGTERM drains queues with configurable timeout
- Slack notifications via Incoming Webhook for failure events
- Telegram notifications via Bot API (HTML parse_mode) for failure events
- Notification dedup by (installation, repo, run_id, kind) via TTL-cache
- Dead-letter structured logging for failed notification delivery
- Multi-stage Dockerfile on node:24-alpine with non-root user and tini PID 1

[Unreleased]: https://github.com/bouvens/auto-merge/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/bouvens/auto-merge/releases/tag/v1.0.0
