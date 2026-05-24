import type { Octokit } from "@octokit/core";
import type { NotifyHealthChecker } from "../../src/notify/healthCheck.js";

// Tests outside the diagnose route still must satisfy buildServer's mandatory diagnose deps; this stub trio is a typed no-op surface.
export const diagnoseDepsStub: {
  healthChecker: NotifyHealthChecker;
  getAppOctokit: () => Octokit;
  getInstallationOctokit: (installationId: number) => Promise<Octokit>;
} = {
  healthChecker: {
    getStatus: () => ({ slack: "n/a", telegram: "n/a" }),
    refresh: async () => {},
  },
  getAppOctokit: () => ({}) as Octokit,
  getInstallationOctokit: async () => ({}) as Octokit,
};
