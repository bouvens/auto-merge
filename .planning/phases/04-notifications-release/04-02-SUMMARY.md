---
phase: 04-notifications-release
plan: "02"
subsystem: notify-formatters
tags: [notifications, slack, telegram, formatters, tdd, escaping, mrkdwn, html]
dependency_graph:
  requires:
    - src/notify/channel.ts (NotifyEvent union from 04-01)
    - src/notify/escape.ts (escapeHtml, truncate from 04-01)
  provides:
    - src/notify/formatters/slack.ts (formatSlack — mrkdwn string per NotifyEvent.kind)
    - src/notify/formatters/telegram.ts (formatTelegram — HTML string ≤ 4014 chars per NotifyEvent.kind)
  affects:
    - 04-03 channel implementations (SlackChannel, TelegramChannel will call these formatters)
tech_stack:
  added: []
  patterns:
    - Object-map formatters keyed by NotifyEvent.kind — TS exhaustiveness enforced by mapped type
    - escapeHtml on every dynamic interpolation; URLs in href/mrkdwn link constructs stay raw
    - truncate(4000) safety margin applied at formatTelegram return boundary
key_files:
  created:
    - src/notify/formatters/slack.ts
    - src/notify/formatters/telegram.ts
    - test/unit/notify-formatter-slack.test.ts
    - test/unit/notify-formatter-telegram.test.ts
  modified: []
decisions:
  - escapeHtml applied to all dynamic fields including author_login and zod_error (T-04-04, T-04-05 mitigations)
  - URLs inside Slack <URL|text> syntax and Telegram href="" attributes stay raw — GitHub URLs are ASCII-safe per RESEARCH.md
  - author_login fallback is "unknown" (not "unknown author") — consistent between both formatters
  - run_id displayed as first 8 chars in Slack messages for readability; Telegram omits run_id for conciseness
metrics:
  duration: "3 min"
  completed: "2026-05-22T10:28:09Z"
  tasks: 2
  files: 4
---

# Phase 04 Plan 02: Notify Formatters Summary

Slack mrkdwn and Telegram HTML per-channel message formatters covering all 5 NotifyEvent kinds via TypeScript-exhaustive object-maps, with HTML-escaping on all dynamic fields and 4000-char truncation for Telegram.

## What Was Built

### Task 1: Slack formatter (src/notify/formatters/slack.ts)

**formatSlack(event: NotifyEvent): string**

Object-map (`formatters`) keyed by every `NotifyEvent["kind"]` — TypeScript's mapped type `{ [K in NotifyEvent["kind"]]: ... }` enforces exhaustiveness at compile time.

Templates per kind:
- `queue_overflow`: bold heading + key + dropped_id in code-spans
- `cascade_conflict`: bold heading + Slack `<URL|PR created>` link (raw URL), repo/src→tgt in code-spans, `@author` mention (escapeHtml-escaped), run_id first 8 chars
- `protection_blocked`: bold heading + rule in code-span + PR link + author mention
- `permission_error`: bold heading + missing_permission + endpoint + status + repo/src→tgt (no PR link — PR not created)
- `config_invalid`: bold heading + repo + config_path + zod_error (all escaped)

15 escapeHtml calls, 0 switch-case usages. 16 tests passing.

### Task 2: Telegram formatter (src/notify/formatters/telegram.ts)

**formatTelegram(event: NotifyEvent): string**

Same object-map pattern. HTML parse_mode output with `<b>`, `<code>`, `<a href>` tags. `truncate(fn(event))` called at return boundary — caps output at 4000 chars + `…[truncated]` suffix (≤ 4014 total).

Templates per kind (all HTML-structured):
- `queue_overflow`: `<b>Queue overflow</b>` + `<code>key</code>` + `<code>dropped_id</code>`
- `cascade_conflict`: `<b>Cascade conflict</b>` + `<code>src</code>` → `<code>tgt</code>` + author (escaped) + `<a href="URL">View PR</a>` (raw URL in href)
- `protection_blocked`: adds `<code>rule</code>` line
- `permission_error`: `<b>Permission error</b>` + `<code>missing_permission</code>` + `<code>endpoint</code>` (status) + repo/src→tgt
- `config_invalid`: `<b>Invalid config</b>` + repo + config_path + zod_error (escaped)

16 escapeHtml calls, 1 truncate call, 0 switch-case usages. 18 tests passing.

## Threat Mitigations Verified

- **T-04-04** (Telegram HTML injection): escapeHtml on every dynamic interpolation — confirmed by grep count ≥ 5 per file
- **T-04-05** (Slack mrkdwn injection): angle brackets in user content become `&lt;`/`&gt;` — cannot open `<URL|text>` link syntax
- **T-04-06** (DoS via huge zod_error): truncate boundary test confirms `length 4001 → 4000 + suffix.length`

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes. Pure string transformation functions.

## Known Stubs

None — pure formatters, no I/O or data flow.

## Self-Check: PASSED

Files exist:
- /Users/alex/work/auto-merge/.claude/worktrees/agent-aabc97be8ccf58fa1/src/notify/formatters/slack.ts ✓
- /Users/alex/work/auto-merge/.claude/worktrees/agent-aabc97be8ccf58fa1/src/notify/formatters/telegram.ts ✓
- /Users/alex/work/auto-merge/.claude/worktrees/agent-aabc97be8ccf58fa1/test/unit/notify-formatter-slack.test.ts ✓
- /Users/alex/work/auto-merge/.claude/worktrees/agent-aabc97be8ccf58fa1/test/unit/notify-formatter-telegram.test.ts ✓

Commits exist:
- 09629fa: test(04-02): add failing tests for Slack formatter ✓
- a979126: feat(04-02): implement Slack mrkdwn formatter object-map ✓
- 09cf0cc: test(04-02): add failing tests for Telegram formatter ✓
- 9dc53af: feat(04-02): implement Telegram HTML formatter object-map with truncate ✓
