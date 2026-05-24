import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ConfigSchema } from "../../src/config/schema.js";
import {
  DISPATCH_WORKFLOW_YML,
  buildPrBody,
  buildYmlConfig,
} from "../../src/onboarding/templates.js";

describe("buildYmlConfig", () => {
  it("returns schema-valid YAML for default branch 'main'", () => {
    const out = buildYmlConfig("main");
    expect(out).toContain("main_branch: main");
    expect(out).toContain("# release_branch:");
    const parsed = parse(out);
    expect(() => ConfigSchema.parse(parsed)).not.toThrow();
  });

  it("accepts slashed branch names like feature/x (Git ref rule)", () => {
    const out = buildYmlConfig("feature/x");
    const parsed = parse(out);
    expect(() => ConfigSchema.parse(parsed)).not.toThrow();
    expect(out).toContain("main_branch: feature/x");
  });

  it("rejects branch name containing '..'", () => {
    expect(() => buildYmlConfig("../escape")).toThrow(/invalid default branch/);
  });

  it("rejects empty branch name", () => {
    expect(() => buildYmlConfig("")).toThrow(/invalid default branch/);
  });

  it("rejects branch name with shell special chars", () => {
    expect(() => buildYmlConfig("$(rm -rf)")).toThrow(/invalid default branch/);
  });
});

describe("DISPATCH_WORKFLOW_YML", () => {
  it("is valid YAML", () => {
    expect(() => parse(DISPATCH_WORKFLOW_YML)).not.toThrow();
  });

  it("contains workflow_dispatch trigger", () => {
    const parsed = parse(DISPATCH_WORKFLOW_YML) as { on?: { workflow_dispatch?: unknown } };
    expect(parsed.on?.workflow_dispatch).toBeTruthy();
  });

  it("matches snapshot", () => {
    expect(DISPATCH_WORKFLOW_YML).toMatchSnapshot();
  });
});

describe("buildPrBody", () => {
  it("contains owner/repo and defaultBranch substitutions; checklist has 3 items", () => {
    const body = buildPrBody({ owner: "acme", repo: "api", defaultBranch: "main" });
    expect(body).toContain("acme/api");
    expect(body).toContain("main");
    expect(body.match(/- \[ \]/g)?.length).toBe(3);
    expect(body).not.toContain("@");
    expect(body).not.toContain("/diagnose/");
  });

  it("includes @mention for valid GitHub login", () => {
    const body = buildPrBody({
      owner: "acme",
      repo: "api",
      defaultBranch: "main",
      senderLogin: "octocat",
    });
    expect(body).toContain("@octocat");
  });

  it("includes diagnose link when publicUrl provided", () => {
    const body = buildPrBody({
      owner: "acme",
      repo: "api",
      defaultBranch: "main",
      publicUrl: "https://app.example.com",
    });
    expect(body).toContain("https://app.example.com/diagnose/acme/api");
  });

  it("drops mention silently when senderLogin fails GitHub login regex", () => {
    const body = buildPrBody({
      owner: "acme",
      repo: "api",
      defaultBranch: "main",
      senderLogin: "evil[bot]",
    });
    expect(body).not.toContain("@evil[bot]");
  });

  it("drops mention when senderLogin exceeds 39 chars", () => {
    const tooLong = "0123456789012345678901234567890123456789a"; // 41 chars
    const body = buildPrBody({
      owner: "acme",
      repo: "api",
      defaultBranch: "main",
      senderLogin: tooLong,
    });
    expect(body).not.toContain(`@${tooLong}`);
  });

  it("matches snapshot with all fields populated", () => {
    const body = buildPrBody({
      owner: "acme",
      repo: "api",
      defaultBranch: "main",
      senderLogin: "octocat",
      publicUrl: "https://app.example.com",
    });
    expect(body).toMatchSnapshot();
  });
});
