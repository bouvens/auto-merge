import type { Octokit } from "@octokit/core";
import type { Logger } from "pino";
import { loadConfig as realLoadConfig } from "../config/loader.js";
import type { NotifyHealthChecker, NotifyStatus } from "../notify/healthCheck.js";
import type {
  AppInstalledCheck,
  AppPermissionsCheck,
  BranchCheck,
  BranchesCheck,
  ConfigCheck,
  DiagnoseChecks,
  NotifyCheck,
  OnboardingCheck,
} from "./types.js";

// Mirrors src/notify/healthCheck.ts PROBE_TIMEOUT_MS — operator's pain threshold; with Promise.allSettled bounds total handler latency.
const PROBE_TIMEOUT_MS = 3000;

export interface RunProbesDeps {
  owner: string;
  repo: string;
  appOctokit: Octokit;
  octokitFactory: (installationId: number) => Promise<Octokit>;
  healthChecker: NotifyHealthChecker;
  log: Logger;
  // Required permissions live as a constant in handler.ts (D-15 — single source of truth); passed in as a dependency to keep probes pure and avoid forward import.
  requiredPermissions: Record<string, string>;
  // Injection seam — defaults to real loadConfig; tests stub to avoid msw-ing the Contents endpoint inside loadConfig itself.
  loadConfigFn?: typeof realLoadConfig;
}

type ProbeOk<T> = { value: T; err?: undefined };
type ProbeErr = { value?: undefined; err: { status?: number; message: string } };
type ProbeResult<T> = ProbeOk<T> | ProbeErr;

// 404 is data (not installed / unprotected / no file) — caller decides; only non-404 is logged as a real probe failure.
async function safeProbe<T>(
  name: string,
  owner: string,
  repo: string,
  log: Logger,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<ProbeResult<T>> {
  try {
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const value = await fn(signal);
    return { value };
  } catch (e) {
    const status = (e as { status?: number; name?: string }).status;
    const name_ = (e as { name?: string }).name;
    const message =
      name_ === "TimeoutError" || name_ === "AbortError"
        ? "timeout"
        : e instanceof Error
          ? e.message
          : String(e);
    if (status !== 404) {
      log.warn({ event: "diagnose_probe_failed", probe: name, owner, repo, status, msg: message });
    }
    return { err: { status, message } };
  }
}

function naChecks(
  owner: string,
  requiredPermissions: Record<string, string>,
): Omit<DiagnoseChecks, "app_installed"> {
  return {
    app_permissions: {
      status: "n/a",
      actual: {},
      required: requiredPermissions,
      missing: [],
    },
    config: { status: "n/a" },
    branches: { status: "n/a", branches: {} },
    notify: { status: "n/a", slack: "n/a", telegram: "n/a" },
    onboarding: {
      status: "n/a",
      config_present: false,
      hint: `app not installed on ${owner} — install it to enable diagnostics`,
    },
  };
}

// write > read; missing if absent OR downgraded.
function diffPermissions(
  required: Record<string, string>,
  actual: Record<string, string>,
): string[] {
  const missing: string[] = [];
  for (const [key, requiredLevel] of Object.entries(required)) {
    const actualLevel = actual[key];
    if (!actualLevel) {
      missing.push(key);
      continue;
    }
    if (requiredLevel === "write" && actualLevel !== "write") {
      missing.push(key);
    }
  }
  return missing;
}

function deriveNotifyStatus(slack: NotifyStatus, telegram: NotifyStatus): NotifyCheck["status"] {
  const channels = [slack, telegram];
  if (channels.some((c) => c === "unreachable" || c === "misconfigured")) return "error";
  if (channels.some((c) => c === "pending")) return "warn";
  return "ok";
}

interface OnboardingDeriveInput {
  config_present: boolean;
  source?: ConfigCheck["source"];
  open_pr?: OnboardingCheck["open_pr"];
}

function deriveOnboarding(input: OnboardingDeriveInput): OnboardingCheck {
  if (input.config_present) {
    return {
      status: "ok",
      config_present: true,
      hint: "config in repo (.github/auto-merge.yml)",
    };
  }
  if (input.source === "file_default" || input.source === "env_default") {
    return {
      status: "ok",
      config_present: false,
      hint: `using org-default config (source: ${input.source})`,
    };
  }
  if (input.open_pr) {
    return {
      status: "warn",
      config_present: false,
      open_pr: input.open_pr,
      hint: `onboarding PR #${input.open_pr.number} waiting for review`,
    };
  }
  return {
    status: "error",
    config_present: false,
    hint: "no config and no onboarding PR — run /setup",
  };
}

interface InstallationResponse {
  id: number;
  permissions?: Record<string, string>;
  events?: string[];
}

interface RepoResponse {
  default_branch: string;
}

interface BranchResponse {
  name: string;
  protected?: boolean;
}

interface BranchProtectionResponse {
  restrictions?: Record<string, unknown>;
}

interface ContentResponse {
  type?: string;
  path?: string;
}

interface PullResponse {
  number: number;
  html_url: string;
}

export async function runProbes(deps: RunProbesDeps): Promise<DiagnoseChecks> {
  const { owner, repo, appOctokit, octokitFactory, healthChecker, log, requiredPermissions } = deps;
  const loadConfigFn = deps.loadConfigFn ?? realLoadConfig;

  // Step A — installation resolve (D-04). Failure here short-circuits everything.
  const repoInstall = await safeProbe<InstallationResponse>(
    "getRepoInstallation",
    owner,
    repo,
    log,
    (signal) =>
      appOctokit
        .request("GET /repos/{owner}/{repo}/installation", { owner, repo, request: { signal } })
        .then((r) => r.data as InstallationResponse),
  );

  if (repoInstall.err) {
    const detail = repoInstall.err.status === 404 ? "app-not-installed" : repoInstall.err.message;
    const app_installed: AppInstalledCheck = { status: "error", detail };
    return { app_installed, ...naChecks(owner, requiredPermissions) };
  }

  const installation_id = repoInstall.value.id;
  const app_installed: AppInstalledCheck = { status: "ok", installation_id };

  const userOctokit = await octokitFactory(installation_id);

  // Step B — gather default_branch (loadConfig requires sha; the repo's default branch is the canonical reference for config lookup and onboarding hints).
  const repoInfo = await safeProbe<RepoResponse>("getRepo", owner, repo, log, (signal) =>
    userOctokit
      .request("GET /repos/{owner}/{repo}", { owner, repo, request: { signal } })
      .then((r) => r.data as RepoResponse),
  );
  const defaultBranch = repoInfo.value?.default_branch ?? "main";

  // Step C — parallel probes (D-05). One failure must not poison siblings — every call is wrapped in safeProbe + run via allSettled.
  const installationProbe = safeProbe<InstallationResponse>(
    "getInstallation",
    owner,
    repo,
    log,
    (signal) =>
      appOctokit
        .request("GET /app/installations/{installation_id}", {
          installation_id,
          request: { signal },
        })
        .then((r) => r.data as InstallationResponse),
  );

  // loadConfig is called with notify: undefined — diagnose path must never trigger notify dispatcher (D-05.2).
  const configProbe = (async (): Promise<
    ProbeResult<Awaited<ReturnType<typeof realLoadConfig>>>
  > => {
    try {
      const value = await loadConfigFn({
        octokit: userOctokit,
        owner,
        repo,
        sha: defaultBranch,
        installation_id,
        notify: undefined,
      });
      return { value };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.warn({ event: "diagnose_probe_failed", probe: "loadConfig", owner, repo, msg: message });
      return { err: { message } };
    }
  })();

  const contentProbe = safeProbe<ContentResponse>("getContent", owner, repo, log, (signal) =>
    userOctokit
      .request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path: ".github/auto-merge.yml",
        ref: defaultBranch,
        request: { signal },
      })
      .then((r) => r.data as ContentResponse),
  );

  const pullsProbe = safeProbe<PullResponse[]>("listPulls", owner, repo, log, (signal) =>
    userOctokit
      .request("GET /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        state: "open",
        head: `${owner}:auto-merge/onboarding`,
        request: { signal },
      })
      .then((r) => r.data as PullResponse[]),
  );

  const [installRes, configRes, contentRes, pullsRes] = await Promise.all([
    installationProbe,
    configProbe,
    contentProbe,
    pullsProbe,
  ]);

  // Assembly — app_permissions.
  const actualPermissions = installRes.value?.permissions ?? {};
  const missing = diffPermissions(requiredPermissions, actualPermissions);
  const app_permissions: AppPermissionsCheck = {
    status: installRes.err ? "error" : missing.length > 0 ? "error" : "ok",
    actual: actualPermissions,
    required: requiredPermissions,
    missing,
  };

  // Assembly — config.
  const configValue = configRes.value;
  const config: ConfigCheck = configRes.err
    ? { status: "error", errors: [configRes.err.message] }
    : configValue?.config
      ? {
          status: "ok",
          source: configValue.source,
          main_branch: configValue.config.main_branch,
          release_branch: configValue.config.release_branch,
          dev_branch: configValue.config.dev_branch,
        }
      : {
          status: "error",
          source: configValue?.source,
          errors: configValue?.errors?.map((e) => `L${e.line}:${e.col} ${e.message}`) ?? [
            "config not resolved",
          ],
        };

  // Assembly — branches (one round-trip pair per branch, in parallel). Skip if config did not resolve.
  const branchNames = [config.main_branch, config.release_branch, config.dev_branch].filter(
    (b): b is string => typeof b === "string" && b.length > 0,
  );
  const branchResults: Record<string, BranchCheck> = {};
  if (branchNames.length > 0) {
    const pairs = await Promise.all(
      branchNames.map(async (branch) => {
        const [branchRes, protectionRes] = await Promise.all([
          safeProbe<BranchResponse>("getBranch", owner, repo, log, (signal) =>
            userOctokit
              .request("GET /repos/{owner}/{repo}/branches/{branch}", {
                owner,
                repo,
                branch,
                request: { signal },
              })
              .then((r) => r.data as BranchResponse),
          ),
          safeProbe<BranchProtectionResponse>("getBranchProtection", owner, repo, log, (signal) =>
            userOctokit
              .request("GET /repos/{owner}/{repo}/branches/{branch}/protection", {
                owner,
                repo,
                branch,
                request: { signal },
              })
              .then((r) => r.data as BranchProtectionResponse),
          ),
        ]);
        const exists = !(branchRes.err?.status === 404);
        // 404 on protection endpoint is normal — branch simply has no protection rule (D-05.3).
        const isProtected = !protectionRes.err && protectionRes.value !== undefined;
        const check: BranchCheck = {
          exists,
          protected: isProtected,
          ...(isProtected && protectionRes.value?.restrictions
            ? { restrictions: protectionRes.value.restrictions }
            : {}),
        };
        return [branch, check] as const;
      }),
    );
    for (const [branch, check] of pairs) {
      branchResults[branch] = check;
    }
  }
  const anyBranchMissing = Object.values(branchResults).some((b) => !b.exists);
  const branches: BranchesCheck = {
    status:
      branchNames.length === 0
        ? "n/a"
        : anyBranchMissing
          ? "error"
          : Object.values(branchResults).every((b) => b.protected)
            ? "ok"
            : "warn",
    branches: branchResults,
  };

  // Assembly — notify (single getStatus() call — cached upstream, no per-request probe of Slack/Telegram).
  const notifyStatus = healthChecker.getStatus();
  const notify: NotifyCheck = {
    status: deriveNotifyStatus(notifyStatus.slack, notifyStatus.telegram),
    slack: notifyStatus.slack,
    telegram: notifyStatus.telegram,
  };

  // Assembly — onboarding (D-14 decision table).
  const config_present = !contentRes.err && contentRes.value?.type === "file";
  const firstPull = pullsRes.value?.[0];
  const open_pr = firstPull
    ? { number: firstPull.number, html_url: firstPull.html_url }
    : undefined;
  const onboarding = deriveOnboarding({
    config_present,
    source: configValue?.source,
    open_pr,
  });

  return {
    app_installed,
    app_permissions,
    config,
    branches,
    notify,
    onboarding,
  };
}
