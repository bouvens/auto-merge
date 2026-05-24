import type { ConfigSource } from "../config/loader.js";
import type { NotifyStatus } from "../notify/healthCheck.js";

export type { ConfigSource } from "../config/loader.js";
export type { NotifyStatus } from "../notify/healthCheck.js";

export type ProbeStatus = "ok" | "warn" | "error" | "n/a";

export interface AppInstalledCheck {
  status: ProbeStatus;
  detail?: string;
  installation_id?: number;
}

export interface AppPermissionsCheck {
  status: ProbeStatus;
  actual: Record<string, string>;
  required: Record<string, string>;
  // Plain string[] (not object shape) — D-15 discretion: ergonomic for JSON consumers and Markdown bullets; the diff context (required vs actual) is already on the same payload.
  missing: string[];
}

export interface ConfigCheck {
  status: ProbeStatus;
  source?: ConfigSource;
  main_branch?: string;
  release_branch?: string;
  dev_branch?: string;
  errors?: string[];
}

export interface BranchCheck {
  exists: boolean;
  protected: boolean;
  restrictions?: Record<string, unknown>;
}

export interface BranchesCheck {
  status: ProbeStatus;
  branches: Record<string, BranchCheck>;
}

export interface NotifyCheck {
  status: ProbeStatus;
  slack: NotifyStatus;
  telegram: NotifyStatus;
}

export interface OnboardingCheck {
  status: ProbeStatus;
  config_present: boolean;
  open_pr?: { number: number; html_url: string };
  hint: string;
}

export interface DiagnoseChecks {
  app_installed: AppInstalledCheck;
  app_permissions: AppPermissionsCheck;
  config: ConfigCheck;
  branches: BranchesCheck;
  notify: NotifyCheck;
  onboarding: OnboardingCheck;
}

export interface DiagnoseReport {
  ok: boolean;
  owner: string;
  repo: string;
  checked_at: string;
  checks: DiagnoseChecks;
}
