import type { Octokit } from "@octokit/core";
import { describe, expect, it, vi } from "vitest";
import { protectionCheck } from "../../src/cascade/protectionCheck.js";

function makeDeps(requestFn: ReturnType<typeof vi.fn>) {
  return {
    octokit: { request: requestFn } as unknown as Octokit,
    owner: "test-owner",
    repo: "test-repo",
    appSlug: "my-app",
  };
}

describe("protectionCheck", () => {
  it("404 → not blocked (no protection configured)", async () => {
    const req = vi.fn().mockRejectedValueOnce({ status: 404 });
    const result = await protectionCheck(makeDeps(req), "release");
    expect(result).toEqual({ blocked: false });
  });

  it("403 → permission_error", async () => {
    const req = vi.fn().mockRejectedValueOnce({ status: 403 });
    const result = await protectionCheck(makeDeps(req), "release");
    expect(result).toEqual({ permission_error: true, status: 403 });
  });

  it("non-403/404 status re-throws", async () => {
    const req = vi.fn().mockRejectedValueOnce({ status: 500 });
    await expect(protectionCheck(makeDeps(req), "release")).rejects.toMatchObject({ status: 500 });
  });

  it("200 + required_pull_request_reviews → blocked", async () => {
    const req = vi.fn().mockResolvedValueOnce({
      data: { required_pull_request_reviews: { dismiss_stale_reviews: true } },
    });
    const result = await protectionCheck(makeDeps(req), "release");
    expect(result).toEqual({ blocked: true, rules: ["required_pull_request_reviews"] });
  });

  it("200 + bypass-actor includes our App → STILL blocked (A5)", async () => {
    const req = vi.fn().mockResolvedValueOnce({
      data: {
        required_pull_request_reviews: {
          dismiss_stale_reviews: true,
          bypass_pull_request_allowances: { apps: [{ slug: "my-app" }] },
        },
      },
    });
    const result = await protectionCheck(makeDeps(req), "release");
    expect(result).toEqual({ blocked: true, rules: ["required_pull_request_reviews"] });
  });

  it("200 + required_status_checks with empty contexts AND empty checks → not blocked", async () => {
    const req = vi.fn().mockResolvedValueOnce({
      data: { required_status_checks: { contexts: [], checks: [] } },
    });
    const result = await protectionCheck(makeDeps(req), "release");
    expect(result).toEqual({ blocked: false });
  });

  it("200 + required_status_checks with one context → blocked", async () => {
    const req = vi.fn().mockResolvedValueOnce({
      data: { required_status_checks: { contexts: ["ci/build"], checks: [] } },
    });
    const result = await protectionCheck(makeDeps(req), "release");
    expect(result).toEqual({ blocked: true, rules: ["required_status_checks"] });
  });

  it("200 + required_signatures.enabled=true → blocked", async () => {
    const req = vi.fn().mockResolvedValueOnce({
      data: { required_signatures: { enabled: true } },
    });
    const result = await protectionCheck(makeDeps(req), "release");
    expect(result).toEqual({ blocked: true, rules: ["required_signatures"] });
  });

  it("200 + required_linear_history.enabled=true → blocked", async () => {
    const req = vi.fn().mockResolvedValueOnce({
      data: { required_linear_history: { enabled: true } },
    });
    const result = await protectionCheck(makeDeps(req), "release");
    expect(result).toEqual({ blocked: true, rules: ["required_linear_history"] });
  });

  it("200 + restrictions includes our App slug → not blocked", async () => {
    const req = vi.fn().mockResolvedValueOnce({
      data: { restrictions: { apps: [{ slug: "my-app" }] } },
    });
    const result = await protectionCheck(makeDeps(req), "release");
    expect(result).toEqual({ blocked: false });
  });

  it("200 + restrictions without our App slug → blocked", async () => {
    const req = vi.fn().mockResolvedValueOnce({
      data: { restrictions: { apps: [{ slug: "other-app" }] } },
    });
    const result = await protectionCheck(makeDeps(req), "release");
    expect(result).toEqual({ blocked: true, rules: ["restrictions"] });
  });

  it("200 + lock_branch.enabled=true → blocked", async () => {
    const req = vi.fn().mockResolvedValueOnce({
      data: { lock_branch: { enabled: true } },
    });
    const result = await protectionCheck(makeDeps(req), "release");
    expect(result).toEqual({ blocked: true, rules: ["lock_branch"] });
  });

  it("200 + multiple rules match → rules array contains all matched names", async () => {
    const req = vi.fn().mockResolvedValueOnce({
      data: {
        required_pull_request_reviews: { dismiss_stale_reviews: true },
        required_linear_history: { enabled: true },
      },
    });
    const result = await protectionCheck(makeDeps(req), "release");
    expect(result).toMatchObject({ blocked: true });
    const blocked = result as { blocked: true; rules: string[] };
    expect(blocked.rules).toContain("required_pull_request_reviews");
    expect(blocked.rules).toContain("required_linear_history");
    expect(blocked.rules.length).toBeGreaterThanOrEqual(2);
  });

  it("200 + no rules match (empty protection object) → not blocked", async () => {
    const req = vi.fn().mockResolvedValueOnce({ data: {} });
    const result = await protectionCheck(makeDeps(req), "release");
    expect(result).toEqual({ blocked: false });
  });
});
