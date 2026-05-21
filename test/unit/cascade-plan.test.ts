import type { Octokit } from "@octokit/core";
import { describe, expect, it, vi } from "vitest";
import { buildCascadePlan } from "../../src/cascade/plan.js";
import type { Config } from "../../src/config/schema.js";

const baseConfig: Config = {
  main_branch: "main",
  dev_branch: "dev",
};

function mockOctokit(impl: (params: unknown) => Promise<unknown>): Octokit {
  return { request: vi.fn(impl) } as unknown as Octokit;
}

describe("buildCascadePlan", () => {
  it("main push, no release in config → [main→dev], no octokit calls", async () => {
    const request = vi.fn();
    const octokit = { request } as unknown as Octokit;
    const out = await buildCascadePlan(
      { octokit, owner: "o", repo: "r" },
      baseConfig,
      "main",
    );
    expect(out).toEqual([{ src: "main", tgt: "dev" }]);
    expect(request).not.toHaveBeenCalled();
  });

  it("main push, release in config, 200 → two pairs", async () => {
    const octokit = mockOctokit(async () => ({
      status: 200,
      data: { name: "release" },
    }));
    const out = await buildCascadePlan(
      { octokit, owner: "o", repo: "r" },
      { ...baseConfig, release_branch: "release" },
      "main",
    );
    expect(out).toEqual([
      { src: "main", tgt: "release" },
      { src: "release", tgt: "dev" },
    ]);
  });

  it("main push, release in config, 404 → fallback main→dev (1 octokit call)", async () => {
    const request = vi.fn(async () => {
      const err = new Error("Not Found") as Error & { status?: number };
      err.status = 404;
      throw err;
    });
    const octokit = { request } as unknown as Octokit;
    const out = await buildCascadePlan(
      { octokit, owner: "o", repo: "r" },
      { ...baseConfig, release_branch: "release" },
      "main",
    );
    expect(out).toEqual([{ src: "main", tgt: "dev" }]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("main push, release in config, 500 → rethrows", async () => {
    const request = vi.fn(async () => {
      const err = new Error("Server Error") as Error & { status?: number };
      err.status = 500;
      throw err;
    });
    const octokit = { request } as unknown as Octokit;
    await expect(
      buildCascadePlan(
        { octokit, owner: "o", repo: "r" },
        { ...baseConfig, release_branch: "release" },
        "main",
      ),
    ).rejects.toThrow(/Server Error/);
  });

  it("release_branch push → [release→dev], no octokit calls", async () => {
    const request = vi.fn();
    const octokit = { request } as unknown as Octokit;
    const out = await buildCascadePlan(
      { octokit, owner: "o", repo: "r" },
      { ...baseConfig, release_branch: "release" },
      "release",
    );
    expect(out).toEqual([{ src: "release", tgt: "dev" }]);
    expect(request).not.toHaveBeenCalled();
  });

  it("branch not in cascade → throws", async () => {
    const octokit = mockOctokit(async () => ({ status: 200, data: {} }));
    await expect(
      buildCascadePlan(
        { octokit, owner: "o", repo: "r" },
        { ...baseConfig, release_branch: "release" },
        "feature/x",
      ),
    ).rejects.toThrow(/pushedBranch not in cascade/);
  });
});
