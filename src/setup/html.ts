// Table-driven replace keeps the dangerous-char set declarative — project convention prefers maps over branching.
const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c] ?? c);
}

// Stringify first so the HTML pass escapes the structural quotes JSON emits; safe to inline into value="...".
export function jsonForHtmlAttr(obj: unknown): string {
  return escapeHtml(JSON.stringify(obj));
}
