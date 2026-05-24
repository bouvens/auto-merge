import { describe, expect, it } from "vitest";
import { redactSecret, redactSlackUrl } from "./redact.js";

describe("redactSlackUrl", () => {
  it("returns null for undefined", () => {
    expect(redactSlackUrl(undefined)).toBeNull();
  });

  it("masks the path segment after the last slash", () => {
    expect(redactSlackUrl("https://hooks.slack.com/services/T1/B1/abc123")).toBe(
      "https://hooks.slack.com/services/T1/B1/****",
    );
  });

  it("still appends /**** when there is no trailing path segment", () => {
    const out = redactSlackUrl("https://hooks.slack.com/services");
    expect(out).not.toBeNull();
    expect((out as string).endsWith("/****")).toBe(true);
  });
});

describe("redactSecret", () => {
  it("reports absent secret for undefined", () => {
    expect(redactSecret(undefined)).toEqual({ present: false, byte_length: 0 });
  });

  it("reports utf-8 byte length for present secret", () => {
    expect(redactSecret("abc")).toEqual({ present: true, byte_length: 3 });
  });
});
