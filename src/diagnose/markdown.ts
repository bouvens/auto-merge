import type { DiagnoseReport, ProbeStatus } from "./types.js";

// Object-as-map per CLAUDE.md preference; deterministic emoji per ProbeStatus.
const STATUS_EMOJI: Record<ProbeStatus, string> = {
  ok: "✅",
  warn: "⚠️",
  error: "❌",
  "n/a": "➖",
};

function line(emoji: string, text: string): string {
  return `- ${emoji} ${text}`;
}

function formatPermsMap(map: Record<string, string>): string {
  const keys = Object.keys(map).sort();
  if (keys.length === 0) return "{}";
  return `{${keys.map((k) => `${k}:${map[k]}`).join(", ")}}`;
}

function formatMissing(missing: string[]): string {
  if (missing.length === 0) return "[]";
  return `[${missing.join(", ")}]`;
}

function renderApp(report: DiagnoseReport): string {
  const { app_installed, app_permissions } = report.checks;
  const installedDetail =
    app_installed.detail ??
    (app_installed.installation_id != null
      ? `yes (installation_id=${app_installed.installation_id})`
      : "unknown");
  const permsLine = `permissions: actual=${formatPermsMap(app_permissions.actual)}; required=${formatPermsMap(
    app_permissions.required,
  )}; missing=${formatMissing(app_permissions.missing)}`;
  return [
    "## App",
    line(STATUS_EMOJI[app_installed.status], `installed: ${installedDetail}`),
    line(STATUS_EMOJI[app_permissions.status], permsLine),
  ].join("\n");
}

function renderConfig(report: DiagnoseReport): string {
  const c = report.checks.config;
  const errors = c.errors && c.errors.length > 0 ? c.errors.join("; ") : "-";
  return [
    "## Config",
    line(STATUS_EMOJI[c.status], `source: ${c.source ?? "none"}`),
    `- main_branch: ${c.main_branch ?? "-"}`,
    `- release_branch: ${c.release_branch ?? "-"}`,
    `- dev_branch: ${c.dev_branch ?? "-"}`,
    `- errors: ${errors}`,
  ].join("\n");
}

function renderBranches(report: DiagnoseReport): string {
  const b = report.checks.branches;
  const names = Object.keys(b.branches).sort();
  const rows =
    names.length === 0
      ? ["- (no branches resolved)"]
      : names.map((name) => {
          // names derived from Object.keys(b.branches) — entry is guaranteed defined.
          const entry = b.branches[name] as { exists: boolean; protected: boolean };
          return `- ${name}: exists=${entry.exists}, protected=${entry.protected}`;
        });
  return ["## Branches", ...rows].join("\n");
}

function renderNotify(report: DiagnoseReport): string {
  const n = report.checks.notify;
  return [
    "## Notify",
    line(STATUS_EMOJI[statusFromNotify(n.slack)], `slack: ${n.slack}`),
    line(STATUS_EMOJI[statusFromNotify(n.telegram)], `telegram: ${n.telegram}`),
  ].join("\n");
}

// Map NotifyStatus enum → ProbeStatus emoji bucket. Deterministic, object-driven.
const NOTIFY_TO_PROBE: Record<string, ProbeStatus> = {
  ok: "ok",
  pending: "warn",
  unreachable: "error",
  misconfigured: "error",
  "n/a": "n/a",
};

function statusFromNotify(s: string): ProbeStatus {
  return NOTIFY_TO_PROBE[s] ?? "n/a";
}

function renderOnboarding(report: DiagnoseReport): string {
  const o = report.checks.onboarding;
  const rows: string[] = [
    "## Onboarding",
    line(STATUS_EMOJI[o.status], o.hint),
    `- config_present: ${o.config_present}`,
  ];
  if (o.open_pr) {
    rows.push(`- open_pr: #${o.open_pr.number} ${o.open_pr.html_url}`);
  }
  return rows.join("\n");
}

export function renderMarkdown(report: DiagnoseReport): string {
  const overall = report.ok ? "✅ ok" : "❌ issues found";
  const header = [
    `# Diagnose: ${report.owner}/${report.repo}`,
    "",
    `_checked at ${report.checked_at}_  `,
    `**Overall:** ${overall}`,
  ].join("\n");

  const sections = [
    header,
    renderApp(report),
    renderConfig(report),
    renderBranches(report),
    renderNotify(report),
    renderOnboarding(report),
  ];

  return `${sections.join("\n\n")}\n`;
}
