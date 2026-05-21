import { describe, expect, it } from "vitest";
import { mapError, type Endpoint } from "../../src/cascade/errorMap.js";

describe("mapError", () => {
  describe("returns null for status not in {403, 404}", () => {
    it.each([500, 200, 422, 409])("status %i → null", (status) => {
      expect(mapError("merges", status)).toBeNull();
    });
  });

  describe("returns null for unmapped (endpoint, status)", () => {
    it("branches_protection:404 is intentionally not mapped", () => {
      expect(mapError("branches_protection", 404)).toBeNull();
    });

    it("dispatches:403 is not mapped", () => {
      expect(mapError("dispatches", 403)).toBeNull();
    });

    it("app_installations:404 is not mapped", () => {
      expect(mapError("app_installations", 404)).toBeNull();
    });

    it("installation_repositories:404 is not mapped", () => {
      expect(mapError("installation_repositories", 404)).toBeNull();
    });

    it("checks:422 is not mapped (non-403/404 status)", () => {
      expect(mapError("checks", 422)).toBeNull();
    });
  });

  describe("exhaustive table: all 16 mapped keys return MappedError", () => {
    it.each<[Endpoint, 403 | 404, string | undefined]>([
      ["merges", 403, "release"],
      ["merges", 404, "release"],
      ["pulls", 403, undefined],
      ["pulls", 404, undefined],
      ["checks", 403, undefined],
      ["checks", 404, undefined],
      ["git_refs", 403, undefined],
      ["git_refs", 404, undefined],
      ["branches", 403, undefined],
      ["branches", 404, "release"],
      ["branches_protection", 403, undefined],
      ["compare", 403, undefined],
      ["compare", 404, "release"],
      ["app_installations", 403, undefined],
      ["installation_repositories", 403, undefined],
      ["dispatches", 404, undefined],
    ])("%s:%i returns non-empty summary and missing_permission", (endpoint, status, target) => {
      const result = mapError(endpoint, status, target);
      expect(result).not.toBeNull();
      expect(result!.summary.length).toBeGreaterThan(0);
      expect(result!.missing_permission.length).toBeGreaterThan(0);
      expect(result!.missing_permission).toMatch(/:read|:write|—|JWT auth|implicit|inaccessible/);
    });
  });

  describe("target interpolation", () => {
    it("merges:403 summary contains the target branch name", () => {
      const result = mapError("merges", 403, "release");
      expect(result!.summary).toContain("`release`");
    });

    it("merges:404 summary contains the target branch name", () => {
      const result = mapError("merges", 404, "main");
      expect(result!.summary).toContain("`main`");
    });

    it("branches:404 summary contains the target branch name", () => {
      const result = mapError("branches", 404, "dev");
      expect(result!.summary).toContain("`dev`");
    });

    it("compare:404 summary contains the target branch name", () => {
      const result = mapError("compare", 404, "feature");
      expect(result!.summary).toContain("`feature`");
    });
  });

  describe("summaries are canned text", () => {
    it("same target always produces same summary — no external error properties interpolated", () => {
      const a = mapError("merges", 403, "release");
      const b = mapError("merges", 403, "release");
      expect(a!.summary).toBe(b!.summary);
      expect(a!.missing_permission).toBe(b!.missing_permission);
    });
  });
});
