import type { Octokit } from "@octokit/core";
import { getInstallationOctokit } from "../auth.js";
import { log } from "../log.js";

// Bounded backoff for installation-token race on installation.created (D-22, D-23): 401/404 may appear briefly before the new install propagates; total wait ≤3.5s caps DoS surface.
const BACKOFF_MS = [500, 1000, 2000] as const;

function isTransient(status: number | undefined): boolean {
  return status === 401 || status === 404;
}

export async function getInstallationOctokitWithRetry(
  installationId: number,
): Promise<InstanceType<typeof Octokit> | undefined> {
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      return await getInstallationOctokit(installationId);
    } catch (err) {
      const status = (err as { status?: number }).status;
      const isLast = attempt === BACKOFF_MS.length;
      if (!isTransient(status) || isLast) {
        // Structured {err} lets pino redact paths strip embedded tokens (T-09-03); never serialise err manually.
        log.error(
          { err, installation_id: installationId, attempt, event: "onboard_token_mint_failed" },
          "onboarding",
        );
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt]));
    }
  }
  return undefined;
}
