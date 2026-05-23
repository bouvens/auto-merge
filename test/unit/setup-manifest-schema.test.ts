import { describe, expect, it } from "vitest";
import { buildManifest } from "../../src/setup/manifestSchema.js";

const envA = {
  SETUP_APP_NAME: "auto-merge",
  SETUP_PUBLIC_URL: "https://app.example.com",
};
const envB = {
  SETUP_APP_NAME: "my-merger",
  SETUP_PUBLIC_URL: "https://other.example.org",
};

describe("setup/manifestSchema.buildManifest", () => {
  it("name mirrors env.SETUP_APP_NAME", () => {
    expect(buildManifest(envA, "s1").name).toBe("auto-merge");
    expect(buildManifest(envB, "s1").name).toBe("my-merger");
  });

  it("url mirrors env.SETUP_PUBLIC_URL", () => {
    expect(buildManifest(envA, "s1").url).toBe("https://app.example.com");
    expect(buildManifest(envB, "s1").url).toBe("https://other.example.org");
  });

  it("hook_attributes.url is SETUP_PUBLIC_URL + /webhook", () => {
    expect(buildManifest(envA, "s1").hook_attributes.url).toBe(
      "https://app.example.com/webhook",
    );
    expect(buildManifest(envB, "s1").hook_attributes.url).toBe(
      "https://other.example.org/webhook",
    );
  });

  it("redirect_url is SETUP_PUBLIC_URL + /setup/callback", () => {
    expect(buildManifest(envA, "s1").redirect_url).toBe(
      "https://app.example.com/setup/callback",
    );
  });

  it("public is false (private App by default)", () => {
    expect(buildManifest(envA, "s1").public).toBe(false);
  });

  it("default_permissions deep-equals locked D-11 map", () => {
    expect(buildManifest(envA, "s1").default_permissions).toEqual({
      contents: "write",
      pull_requests: "write",
      checks: "write",
      metadata: "read",
    });
  });

  it("default_events deep-equals locked D-11 list", () => {
    expect(buildManifest(envA, "s1").default_events).toEqual([
      "push",
      "pull_request",
      "installation",
      "installation_repositories",
      "check_run",
    ]);
  });

  it("state echoes the state argument", () => {
    expect(buildManifest(envA, "csrf-uuid-abc").state).toBe("csrf-uuid-abc");
  });

  it("returns exactly the 8 documented top-level fields and nothing else", () => {
    const m = buildManifest(envA, "s1");
    expect(Object.keys(m).sort()).toEqual(
      [
        "default_events",
        "default_permissions",
        "hook_attributes",
        "name",
        "public",
        "redirect_url",
        "state",
        "url",
      ].sort(),
    );
  });

  it("accepts an optional org argument without changing manifest body", () => {
    const without = buildManifest(envA, "s1");
    const withOrg = buildManifest(envA, "s1", "acme");
    expect(withOrg).toEqual(without);
  });

  it("throws when SETUP_PUBLIC_URL is undefined (defence-in-depth)", () => {
    expect(() =>
      buildManifest({ SETUP_APP_NAME: "x", SETUP_PUBLIC_URL: undefined }, "s1"),
    ).toThrow(/SETUP_PUBLIC_URL/);
  });
});
