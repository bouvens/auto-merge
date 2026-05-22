import { Octokit } from "@octokit/core";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/loader.js";

const VALID_YAML = "main_branch: main\ndev_branch: dev\n";
const VALID_YAML_B64 = Buffer.from(VALID_YAML).toString("base64");

// Per-test call counters keyed by sha — reset in afterEach.
const callCounts: Record<string, number> = {};

const server = setupServer(
  http.get("https://api.github.com/repos/o/r/contents/.github%2Fauto-merge.yml", ({ request }) => {
    const url = new URL(request.url);
    const ref = url.searchParams.get("ref") ?? "unknown";
    callCounts[ref] = (callCounts[ref] ?? 0) + 1;
    return HttpResponse.json({
      content: VALID_YAML_B64,
      encoding: "base64",
      type: "file",
      name: "auto-merge.yml",
      path: ".github/auto-merge.yml",
    });
  }),
);

// Unauthenticated Octokit — msw intercepts before hitting the network.
const octokit = new Octokit();

beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  for (const key of Object.keys(callCounts)) {
    delete callCounts[key];
  }
});
afterAll(() => server.close());

describe("loadConfig — GitHub Contents API fetch", () => {
  it("fetches and parses a valid config", async () => {
    const result = await loadConfig({ octokit, owner: "o", repo: "r", sha: "sha-fetch-01", installation_id: 0 });
    expect(result.errors).toHaveLength(0);
    expect(result.config).toEqual({ main_branch: "main", dev_branch: "dev" });
    expect(callCounts["sha-fetch-01"]).toBe(1);
  });

  it("returns cached config on second call — API called only once (D-16)", async () => {
    // Use a unique SHA to avoid cross-test cache contamination.
    const sha = "sha-cache-test-01";
    // First call populates cache.
    await loadConfig({ octokit, owner: "o", repo: "r", sha, installation_id: 0 });
    // Second call must hit cache — no additional API request.
    const result = await loadConfig({ octokit, owner: "o", repo: "r", sha, installation_id: 0 });
    expect(result.errors).toHaveLength(0);
    expect(callCounts[sha]).toBe(1);
  });

  it("makes a new API call for a different sha (cache miss)", async () => {
    const sha = "sha-cache-miss-01";
    const result = await loadConfig({ octokit, owner: "o", repo: "r", sha, installation_id: 0 });
    expect(result.errors).toHaveLength(0);
    expect(callCounts[sha]).toBe(1);
  });
});
