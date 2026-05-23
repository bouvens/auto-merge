import { Octokit } from "@octokit/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// Fresh module per-test: auth.ts holds module-level cache (bootEnv) and we must isolate from sibling auth tests.
afterEach(() => {
  vi.resetModules();
});

describe("getAnonymousOctokit", () => {
  it("returns an Octokit instance without requiring createProbot()", async () => {
    const { getAnonymousOctokit } = await import("../../src/auth.js");
    const octokit = getAnonymousOctokit();
    expect(octokit).toBeInstanceOf(Octokit);
    expect(typeof octokit.request).toBe("function");
  });

  it("returns a fresh instance per call", async () => {
    const { getAnonymousOctokit } = await import("../../src/auth.js");
    const first = getAnonymousOctokit();
    const second = getAnonymousOctokit();
    expect(first).not.toBe(second);
  });

  it("does not throw 'auth not initialised' (contrast with getAppOctokit)", async () => {
    const { getAnonymousOctokit, getAppOctokit } = await import("../../src/auth.js");
    expect(() => getAppOctokit()).toThrow(/auth not initialised/);
    expect(() => getAnonymousOctokit()).not.toThrow();
  });
});
