// Object-map per NotifyEvent.kind — exhaustiveness enforced by TS (CLAUDE.md: prefer objects for mappings).
import type { NotifyEvent } from "../channel.js";
import { escapeHtml, truncate } from "../escape.js";

const formatters: { [K in NotifyEvent["kind"]]: (e: Extract<NotifyEvent, { kind: K }>) => string } = {
  queue_overflow: (e) =>
    `<b>Queue overflow</b>\n` +
    `Repo: <code>${escapeHtml(e.key)}</code>\n` +
    `Dropped: <code>${escapeHtml(e.dropped_id)}</code>`,

  cascade_conflict: (e) =>
    `<b>Cascade conflict</b>\n` +
    `Repo: <code>${escapeHtml(e.repo)}</code>\n` +
    `<code>${escapeHtml(e.src)}</code> → <code>${escapeHtml(e.tgt)}</code>\n` +
    `Author: ${escapeHtml(e.author_login ?? "unknown")}\n` +
    `<a href="${e.pr_url}">View PR</a>` +
    (e.check_run_html_url ? `\n<a href="${e.check_run_html_url}">View Check Run</a>` : ""),

  protection_blocked: (e) =>
    `<b>Protection blocked</b>\n` +
    `Repo: <code>${escapeHtml(e.repo)}</code>\n` +
    `<code>${escapeHtml(e.src)}</code> → <code>${escapeHtml(e.tgt)}</code>\n` +
    `Rule: <code>${escapeHtml(e.rule)}</code>\n` +
    `Author: ${escapeHtml(e.author_login ?? "unknown")}\n` +
    `<a href="${e.pr_url}">View PR</a>` +
    (e.check_run_html_url ? `\n<a href="${e.check_run_html_url}">View Check Run</a>` : ""),

  permission_error: (e) =>
    `<b>Permission error</b>\n` +
    `Missing: <code>${escapeHtml(e.missing_permission)}</code>\n` +
    `Endpoint: <code>${escapeHtml(e.endpoint)}</code> (${e.status})\n` +
    `Repo: <code>${escapeHtml(e.repo)}</code>\n` +
    `<code>${escapeHtml(e.src)}</code> → <code>${escapeHtml(e.tgt)}</code>`,

  config_invalid: (e) =>
    `<b>Invalid config</b>\n` +
    `Repo: <code>${escapeHtml(e.repo)}</code>\n` +
    `<code>${escapeHtml(e.config_path)}</code>\n` +
    `${escapeHtml(e.zod_error)}`,
};

export function formatTelegram(event: NotifyEvent): string {
  const fn = formatters[event.kind] as (e: typeof event) => string;
  return truncate(fn(event));
}
