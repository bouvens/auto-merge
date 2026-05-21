import type { Octokit } from "@octokit/core";
import type { Config } from "../config/schema.js";

export interface CascadePair {
  src: string;
  tgt: string;
}

export async function buildCascadePlan(
  deps: { octokit: Octokit; owner: string; repo: string },
  config: Config,
  pushedBranch: string,
): Promise<CascadePair[]> {
  if (pushedBranch === config.main_branch) {
    if (config.release_branch === undefined) {
      return [{ src: config.main_branch, tgt: config.dev_branch }];
    }
    // repos.getBranch is uncached — release branch may be created/deleted between cascade runs (D-06).
    try {
      await deps.octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", {
        owner: deps.owner,
        repo: deps.repo,
        branch: config.release_branch,
      });
      return [
        { src: config.main_branch, tgt: config.release_branch },
        { src: config.release_branch, tgt: config.dev_branch },
      ];
    } catch (err) {
      // 404 → release missing → CFG-03 fallback main→dev; other errors bubble to orchestrator (cascade_failed) per D-29.
      if ((err as { status?: number }).status === 404) {
        return [{ src: config.main_branch, tgt: config.dev_branch }];
      }
      throw err;
    }
  }

  if (config.release_branch !== undefined && pushedBranch === config.release_branch) {
    return [{ src: config.release_branch, tgt: config.dev_branch }];
  }

  // Defensive guard: webhook handler should have filtered non-cascade branches; this catches refactor regressions.
  throw new Error(`buildCascadePlan: pushedBranch not in cascade ${pushedBranch}`);
}
