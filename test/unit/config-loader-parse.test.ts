import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/loader.js";

describe("parseConfig — no I/O", () => {
  it("returns config for valid YAML", () => {
    const result = parseConfig("main_branch: main\ndev_branch: dev\n");
    expect(result.errors).toHaveLength(0);
    expect(result.config).toEqual({ main_branch: "main", dev_branch: "dev", conflict_pr: true });
  });

  it("returns error for YAML syntax error with line/col defined", () => {
    // The tab character causes a YAML parse error.
    const result = parseConfig("main_branch: main\n\t bad: : :");
    expect(result.config).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    const err = result.errors[0]!;
    expect(typeof err.line).toBe("number");
    expect(typeof err.col).toBe("number");
    expect(typeof err.message).toBe("string");
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("returns error for zod-invalid YAML (missing dev_branch)", () => {
    const result = parseConfig("main_branch: main\n");
    expect(result.config).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    const err = result.errors[0]!;
    // Zod doesn't know source position; we use line=1 col=1 and embed path in message.
    expect(err.line).toBe(1);
    expect(err.col).toBe(1);
    expect(err.message).toContain("dev_branch");
  });
});
