import type { Octokit } from "@octokit/core";

export type BlockingRule =
  | "required_pull_request_reviews"
  | "required_status_checks"
  | "required_signatures"
  | "required_linear_history"
  | "restrictions"
  | "lock_branch";

export type ProtectionResult =
  | { blocked: false }
  | { blocked: true; rules: BlockingRule[] }
  | { permission_error: true; status: 403 }
  | { plan_unavailable: true; status: 403; message: string };

interface ProtectionResponse {
  required_pull_request_reviews?: {
    dismiss_stale_reviews?: boolean;
    bypass_pull_request_allowances?: { apps?: Array<{ slug: string }> };
  } | null;
  required_status_checks?: {
    contexts?: string[];
    checks?: Array<{ context: string; app_id: number | null }>;
  } | null;
  required_signatures?: { enabled: boolean };
  required_linear_history?: { enabled: boolean };
  restrictions?: { apps?: Array<{ slug: string }> } | null;
  lock_branch?: { enabled: boolean };
}

// bypass_pull_request_allowances is ignored per A5 — required_pull_request_reviews != null always blocks even if our App slug is in the bypass list.
const RULE_CHECKS: Record<BlockingRule, (p: ProtectionResponse, appSlug: string) => boolean> = {
  required_pull_request_reviews: (p) => p.required_pull_request_reviews != null,
  required_status_checks: (p) =>
    p.required_status_checks != null &&
    ((p.required_status_checks.contexts?.length ?? 0) > 0 ||
      (p.required_status_checks.checks?.length ?? 0) > 0),
  required_signatures: (p) => p.required_signatures?.enabled === true,
  required_linear_history: (p) => p.required_linear_history?.enabled === true,
  restrictions: (p, appSlug) =>
    p.restrictions != null && !(p.restrictions.apps ?? []).some((a) => a.slug === appSlug),
  lock_branch: (p) => p.lock_branch?.enabled === true,
} as const;

export async function protectionCheck(
  deps: { octokit: Octokit; owner: string; repo: string; appSlug: string },
  target: string,
): Promise<ProtectionResult> {
  const { octokit, owner, repo, appSlug } = deps;
  try {
    const resp = await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}/protection", {
      owner,
      repo,
      branch: target,
    });
    const data = resp.data as ProtectionResponse;
    const matches: BlockingRule[] = [];
    for (const [rule, pred] of Object.entries(RULE_CHECKS)) {
      if (pred(data, appSlug)) matches.push(rule as BlockingRule);
    }
    return matches.length > 0 ? { blocked: true, rules: matches } : { blocked: false };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return { blocked: false };
    if (status === 403) {
      // Free-plan private repos return 403 on this endpoint — feature is billing-gated, not permission.
      const message =
        ((err as { response?: { data?: { message?: string } } }).response?.data?.message ??
          (err as Error).message ??
          "") + "";
      if (/upgrade to github (pro|team)|paid (plan|subscription)/i.test(message)) {
        return { plan_unavailable: true, status: 403, message };
      }
      return { permission_error: true, status: 403 };
    }
    throw err;
  }
}
