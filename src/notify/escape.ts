// & must be replaced first to avoid double-escaping existing entities like &amp; → &amp;amp;
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Safety margin keeps us under Telegram's 4096-char ceiling even when encoding expands slightly.
export function truncate(s: string, limit = 4000, suffix = "…[truncated]"): string {
  return s.length > limit ? s.slice(0, limit) + suffix : s;
}
