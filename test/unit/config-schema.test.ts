import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config/schema.js";

describe("ConfigSchema", () => {
  it("validates minimal valid config", () => {
    const result = ConfigSchema.safeParse({ main_branch: "main", dev_branch: "dev" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.main_branch).toBe("main");
      expect(result.data.dev_branch).toBe("dev");
      expect(result.data.release_branch).toBeUndefined();
      expect(result.data.notifications).toBeUndefined();
    }
  });

  it("validates config with release_branch", () => {
    const result = ConfigSchema.safeParse({
      main_branch: "main",
      release_branch: "release",
      dev_branch: "dev",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.release_branch).toBe("release");
    }
  });

  it("validates config with full notifications block", () => {
    const result = ConfigSchema.safeParse({
      main_branch: "main",
      dev_branch: "dev",
      notifications: {
        slack: { channel: "#deploys" },
        telegram: { chat_id: "-1001234567890" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing dev_branch", () => {
    const result = ConfigSchema.safeParse({ main_branch: "main" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("dev_branch"))).toBe(true);
    }
  });

  it("rejects empty main_branch", () => {
    const result = ConfigSchema.safeParse({ main_branch: "", dev_branch: "dev" });
    expect(result.success).toBe(false);
  });

  it("rejects slack block without channel (CFG-06)", () => {
    const result = ConfigSchema.safeParse({
      main_branch: "main",
      dev_branch: "dev",
      notifications: { slack: {} },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("channel"))).toBe(true);
    }
  });

  it("rejects telegram block without chat_id (CFG-06)", () => {
    const result = ConfigSchema.safeParse({
      main_branch: "main",
      dev_branch: "dev",
      notifications: { telegram: {} },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("chat_id"))).toBe(true);
    }
  });

  it("rejects unknown top-level fields (strict — catches typos in repo configs)", () => {
    const result = ConfigSchema.safeParse({
      main_branch: "main",
      dev_branch: "dev",
      extra: "x",
    });
    expect(result.success).toBe(false);
  });

  it("omitted conflict_pr defaults to true", () => {
    const result = ConfigSchema.safeParse({ main_branch: "main", dev_branch: "dev" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.conflict_pr).toBe(true);
    }
  });

  it("conflict_pr: false parses successfully", () => {
    const result = ConfigSchema.safeParse({
      main_branch: "main",
      dev_branch: "dev",
      conflict_pr: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.conflict_pr).toBe(false);
    }
  });

  it("conflict_pr: 'yes' (non-boolean) fails validation", () => {
    const result = ConfigSchema.safeParse({
      main_branch: "main",
      dev_branch: "dev",
      conflict_pr: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("existing minimal config regression — conflict_pr absent still parses (default true)", () => {
    const result = ConfigSchema.safeParse({
      main_branch: "main",
      release_branch: "release",
      dev_branch: "dev",
      notifications: { slack: { channel: "#ops" } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.conflict_pr).toBe(true);
    }
  });
});
