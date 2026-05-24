import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.js";
import type { DiagnoseReport } from "./types.js";

const CHECKED_AT = "2026-05-24T12:00:00.000Z";

// Fixture A — all green
const fixtureAllGreen: DiagnoseReport = {
  ok: true,
  owner: "acme",
  repo: "widgets",
  checked_at: CHECKED_AT,
  checks: {
    app_installed: {
      status: "ok",
      detail: "yes (installation_id=12345)",
      installation_id: 12345,
    },
    app_permissions: {
      status: "ok",
      actual: {
        contents: "write",
        pull_requests: "write",
        checks: "write",
        metadata: "read",
      },
      required: {
        contents: "write",
        pull_requests: "write",
        checks: "write",
        metadata: "read",
      },
      missing: [],
    },
    config: {
      status: "ok",
      source: "repo",
      main_branch: "main",
      release_branch: "release",
      dev_branch: "dev",
      errors: [],
    },
    branches: {
      status: "ok",
      branches: {
        main: { exists: true, protected: true },
        release: { exists: true, protected: true },
        dev: { exists: true, protected: false },
      },
    },
    notify: {
      status: "ok",
      slack: "ok",
      telegram: "ok",
    },
    onboarding: {
      status: "ok",
      config_present: true,
      hint: "config in repo",
    },
  },
};

// Fixture B — app not installed (downstream n/a)
const fixtureAppNotInstalled: DiagnoseReport = {
  ok: false,
  owner: "acme",
  repo: "widgets",
  checked_at: CHECKED_AT,
  checks: {
    app_installed: {
      status: "error",
      detail: "app-not-installed",
    },
    app_permissions: {
      status: "n/a",
      actual: {},
      required: {
        contents: "write",
        pull_requests: "write",
        checks: "write",
        metadata: "read",
      },
      missing: [],
    },
    config: {
      status: "n/a",
    },
    branches: {
      status: "n/a",
      branches: {},
    },
    notify: {
      status: "n/a",
      slack: "n/a",
      telegram: "n/a",
    },
    onboarding: {
      status: "n/a",
      config_present: false,
      hint: "app not installed",
    },
  },
};

// Fixture C — permission gap + missing branch
const fixturePermissionAndBranchGap: DiagnoseReport = {
  ok: false,
  owner: "acme",
  repo: "widgets",
  checked_at: CHECKED_AT,
  checks: {
    app_installed: {
      status: "ok",
      detail: "yes (installation_id=12345)",
      installation_id: 12345,
    },
    app_permissions: {
      status: "error",
      actual: {
        pull_requests: "write",
        checks: "write",
        metadata: "read",
      },
      required: {
        contents: "write",
        pull_requests: "write",
        checks: "write",
        metadata: "read",
      },
      missing: ["contents"],
    },
    config: {
      status: "ok",
      source: "repo",
      main_branch: "main",
      release_branch: "release",
      dev_branch: "dev",
      errors: [],
    },
    branches: {
      status: "error",
      branches: {
        main: { exists: true, protected: true },
        release: { exists: false, protected: false },
        dev: { exists: true, protected: false },
      },
    },
    notify: {
      status: "ok",
      slack: "ok",
      telegram: "n/a",
    },
    onboarding: {
      status: "ok",
      config_present: true,
      hint: "config in repo",
    },
  },
};

// Fixture D — onboarding warn with open PR
const fixtureOnboardingWarn: DiagnoseReport = {
  ok: false,
  owner: "acme",
  repo: "widgets",
  checked_at: CHECKED_AT,
  checks: {
    app_installed: {
      status: "ok",
      detail: "yes (installation_id=12345)",
      installation_id: 12345,
    },
    app_permissions: {
      status: "ok",
      actual: {
        contents: "write",
        pull_requests: "write",
        checks: "write",
        metadata: "read",
      },
      required: {
        contents: "write",
        pull_requests: "write",
        checks: "write",
        metadata: "read",
      },
      missing: [],
    },
    config: {
      status: "warn",
      source: undefined,
      errors: ["no config in repo and no defaults provided"],
    },
    branches: {
      status: "warn",
      branches: {
        main: { exists: true, protected: false },
      },
    },
    notify: {
      status: "ok",
      slack: "ok",
      telegram: "ok",
    },
    onboarding: {
      status: "warn",
      config_present: false,
      open_pr: {
        number: 42,
        html_url: "https://github.com/acme/widgets/pull/42",
      },
      hint: "onboarding PR #42 waiting for review",
    },
  },
};

describe("renderMarkdown", () => {
  it("renders all-green report (Fixture A)", () => {
    expect(renderMarkdown(fixtureAllGreen)).toMatchSnapshot();
  });

  it("renders app-not-installed report (Fixture B)", () => {
    expect(renderMarkdown(fixtureAppNotInstalled)).toMatchSnapshot();
  });

  it("renders permission gap + missing branch report (Fixture C)", () => {
    expect(renderMarkdown(fixturePermissionAndBranchGap)).toMatchSnapshot();
  });

  it("renders onboarding warn with open PR report (Fixture D)", () => {
    expect(renderMarkdown(fixtureOnboardingWarn)).toMatchSnapshot();
  });

  it("is deterministic — same input yields identical output", () => {
    const first = renderMarkdown(fixtureAllGreen);
    const second = renderMarkdown(fixtureAllGreen);
    expect(first).toBe(second);
  });

  it("never produces secret-like literals (no raw hooks.slack URLs, bot tokens, PEM)", () => {
    for (const fixture of [
      fixtureAllGreen,
      fixtureAppNotInstalled,
      fixturePermissionAndBranchGap,
      fixtureOnboardingWarn,
    ]) {
      const out = renderMarkdown(fixture);
      expect(out).not.toMatch(/hooks\.slack/);
      expect(out).not.toMatch(/bot[0-9]+:/);
      expect(out).not.toMatch(/BEGIN[ _]?(RSA|EC|OPENSSH)?[ _]?PRIVATE/);
    }
  });
});
