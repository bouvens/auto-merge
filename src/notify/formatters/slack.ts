// Object-map per NotifyEvent.kind — exhaustiveness enforced by TS (CLAUDE.md: prefer objects for mappings).
import type { NotifyEvent } from "../channel.js";
import { escapeHtml } from "../escape.js";

const formatters: { [K in NotifyEvent["kind"]]: (e: Extract<NotifyEvent, { kind: K }>) => string } = {
  queue_overflow: (e) =>
    `*Queue overflow* — repo \`${escapeHtml(e.key)}\` dropped job \`${escapeHtml(e.dropped_id)}\``,

  cascade_conflict: (e) =>
    `*Cascade conflict*\n` +
    `Repo: \`${escapeHtml(e.repo)}\` | \`${escapeHtml(e.src)}\` → \`${escapeHtml(e.tgt)}\`\n` +
    `Author: @${escapeHtml(e.author_login ?? "unknown")}\n` +
    `<${e.pr_url}|PR created>\n` +
    `Run: ${e.check_run_html_url ? `<${e.check_run_html_url}|${escapeHtml(e.run_id.slice(0, 8))}>` : `\`${escapeHtml(e.run_id.slice(0, 8))}\``}`,

  protection_blocked: (e) =>
    `*Protection blocked* — rule \`${escapeHtml(e.rule)}\`\n` +
    `Repo: \`${escapeHtml(e.repo)}\` | \`${escapeHtml(e.src)}\` → \`${escapeHtml(e.tgt)}\`\n` +
    `Author: @${escapeHtml(e.author_login ?? "unknown")}\n` +
    `<${e.pr_url}|View PR>\n` +
    `Run: ${e.check_run_html_url ? `<${e.check_run_html_url}|${escapeHtml(e.run_id.slice(0, 8))}>` : `\`${escapeHtml(e.run_id.slice(0, 8))}\``}`,

  permission_error: (e) =>
    `*Permission error* — missing \`${escapeHtml(e.missing_permission)}\`\n` +
    `Endpoint: \`${escapeHtml(e.endpoint)}\` (${e.status})\n` +
    `Repo: \`${escapeHtml(e.repo)}\` | \`${escapeHtml(e.src)}\` → \`${escapeHtml(e.tgt)}\`\n` +
    `Run: \`${escapeHtml(e.run_id.slice(0, 8))}\``,

  config_invalid: (e) =>
    `*Invalid config* — repo \`${escapeHtml(e.repo)}\`\n` +
    `File: \`${escapeHtml(e.config_path)}\`\n` +
    `Error: ${escapeHtml(e.zod_error)}`,
};

export function formatSlack(event: NotifyEvent): string {
  const fn = formatters[event.kind] as (e: typeof event) => string;
  return fn(event);
}
