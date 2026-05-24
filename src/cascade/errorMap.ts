// Object-map per CLAUDE.md — switch-case forbidden; branches_protection:404 absent: protectionCheck owns that case (no protection = not an error).

export type Endpoint =
  | "merges"
  | "pulls"
  | "checks"
  | "git_refs"
  | "branches"
  | "branches_protection"
  | "compare"
  | "app_installations"
  | "installation_repositories"
  | "dispatches";

export type ErrorKey = `${Endpoint}:${403 | 404}`;

export interface MappedError {
  summary: string;
  missing_permission: string;
}

export const ERROR_MAP: Partial<Record<ErrorKey, (target?: string) => MappedError>> = {
  "merges:403": (target) => ({
    summary: `Cannot push to \`${target}\` — App lacks \`contents: write\` on this repository (or target branch is protected; verify protection settings).`,
    missing_permission: "contents:write",
  }),
  "merges:404": (target) => ({
    summary: `Target branch \`${target}\` does not exist or App installation has no access (\`contents: read\`).`,
    missing_permission: "contents:read",
  }),
  "pulls:403": () => ({
    summary: "Cannot create conflict PR — App lacks `pull_requests: write`.",
    missing_permission: "pull_requests:write",
  }),
  "pulls:404": () => ({
    summary: "Cannot create PR — repository not accessible to App installation.",
    missing_permission: "metadata:read",
  }),
  "checks:403": () => ({
    summary: "Cannot publish Check Run — App lacks `checks: write`.",
    missing_permission: "checks:write",
  }),
  "checks:404": () => ({
    summary: "Check Run target commit not found — repository may not be accessible.",
    missing_permission: "metadata:read",
  }),
  "git_refs:403": () => ({
    summary: "Cannot create `auto-merge/conflict-*` branch — App lacks `contents: write` (refs).",
    missing_permission: "contents:write",
  }),
  "git_refs:404": () => ({
    summary: "Cannot create branch — base SHA not found.",
    missing_permission: "contents:read",
  }),
  "branches:403": () => ({
    summary: "Cannot read branch HEAD — App lacks `contents: read`.",
    missing_permission: "contents:read",
  }),
  "branches:404": (target) => ({
    summary: `Branch \`${target}\` not found (after stale-base retry or pre-flight).`,
    missing_permission: "—",
  }),
  "branches_protection:403": () => ({
    summary: "Cannot pre-flight branch protection — App lacks `administration: read` permission.",
    missing_permission: "administration:read",
  }),
  "compare:403": () => ({
    summary: "Cannot compare commits — App lacks `contents: read`.",
    missing_permission: "contents:read",
  }),
  "compare:404": (target) => ({
    summary: `One of the branches \`${target}\` does not exist.`,
    missing_permission: "—",
  }),
  "app_installations:403": () => ({
    summary: "Cron sweep failed: App JWT cannot list installations.",
    missing_permission: "(JWT auth — check APP_ID / PRIVATE_KEY)",
  }),
  "installation_repositories:403": () => ({
    summary: "Cron sweep failed for installation: cannot list accessible repositories.",
    missing_permission: "metadata:read (implicit)",
  }),
  "dispatches:404": () => ({
    summary: "Dispatch source repo missing.",
    missing_permission: "(received event for inaccessible repo)",
  }),
} as const;

export function mapError(endpoint: Endpoint, status: number, target?: string): MappedError | null {
  if (status !== 403 && status !== 404) return null;
  const key = `${endpoint}:${status}` as ErrorKey;
  const factory = ERROR_MAP[key];
  return factory ? factory(target) : null;
}
