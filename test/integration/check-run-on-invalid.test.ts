import { Octokit } from "@octokit/core";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/loader.js";

// Invalid YAML — tab at start of line causes a parse error.
const INVALID_YAML = "main_branch: main\n\tbad: yaml";
const INVALID_YAML_B64 = Buffer.from(INVALID_YAML).toString("base64");

// Valid YAML but missing dev_branch — zod rejects it.
const INVALID_ZOD_YAML = "main_branch: main\n";
const INVALID_ZOD_YAML_B64 = Buffer.from(INVALID_ZOD_YAML).toString("base64");

interface CapturedCheckRun {
  head_sha: string;
  name: string;
  status: string;
  conclusion: string;
  output: { title: string; summary: string };
}

let capturedCheckRun: CapturedCheckRun | null = null;
let checkRunCallCount = 0;

const server = setupServer(
  // Contents handler — selectable by sha.
  http.get("https://api.github.com/repos/o/r/contents/.github%2Fauto-merge.yml", ({ request }) => {
    const url = new URL(request.url);
    const ref = url.searchParams.get("ref");
    if (ref === "sha-bad-yaml") {
      return HttpResponse.json({
        content: INVALID_YAML_B64,
        encoding: "base64",
        type: "file",
        name: "auto-merge.yml",
        path: ".github/auto-merge.yml",
      });
    }
    if (ref === "sha-bad-zod") {
      return HttpResponse.json({
        content: INVALID_ZOD_YAML_B64,
        encoding: "base64",
        type: "file",
        name: "auto-merge.yml",
        path: ".github/auto-merge.yml",
      });
    }
    return HttpResponse.json({ message: "Not Found" }, { status: 404 });
  }),

  // Check-runs capture handler.
  http.post("https://api.github.com/repos/o/r/check-runs", async ({ request }) => {
    checkRunCallCount++;
    capturedCheckRun = (await request.json()) as CapturedCheckRun;
    return HttpResponse.json({ id: 1, status: "completed" }, { status: 201 });
  }),
);

const octokit = new Octokit();

beforeAll(() => server.listen());
afterEach(() => {
  capturedCheckRun = null;
  checkRunCallCount = 0;
});
afterAll(() => server.close());

describe("Check Run on invalid config", () => {
  it("creates a Check Run with failure on YAML syntax error", async () => {
    const result = await loadConfig({ octokit, owner: "o", repo: "r", sha: "sha-bad-yaml", installation_id: 0 });

    expect(result.config).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(checkRunCallCount).toBe(1);
    expect(capturedCheckRun).not.toBeNull();

    const cr = capturedCheckRun!;
    expect(cr.head_sha).toBe("sha-bad-yaml");
    expect(cr.name).toBe("auto-merge / config");
    expect(cr.status).toBe("completed");
    expect(cr.conclusion).toBe("failure");
    // Summary must contain line:col format — "L1:" is the prefix pattern.
    expect(cr.output.summary).toMatch(/L\d+:\d+/);
  });

  it("creates a Check Run with failure on zod validation error", async () => {
    const result = await loadConfig({ octokit, owner: "o", repo: "r", sha: "sha-bad-zod", installation_id: 0 });

    expect(result.config).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(checkRunCallCount).toBe(1);

    const cr = capturedCheckRun!;
    expect(cr.head_sha).toBe("sha-bad-zod");
    expect(cr.conclusion).toBe("failure");
    // Summary for zod errors contains the field path (dev_branch).
    expect(cr.output.summary).toContain("dev_branch");
  });
});
