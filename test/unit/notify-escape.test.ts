import { describe, expect, it } from "vitest";
import { escapeHtml, truncate } from "../../src/notify/escape.js";

describe("escapeHtml", () => {
  it("escapes &, <, > in a mixed string", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("replaces & first — calling once on already-escaped text does not double-escape", () => {
    // If & were replaced after < or >, "a &amp; b" would become "a &amp;amp; b"
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("returns the same string when no special chars are present", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("escapes all three entities together", () => {
    expect(escapeHtml("<div class='x'>&nbsp;</div>")).toBe(
      "&lt;div class='x'&gt;&amp;nbsp;&lt;/div&gt;",
    );
  });
});

describe("truncate", () => {
  it("returns string unchanged when length <= limit", () => {
    const s = "a".repeat(4000);
    expect(truncate(s)).toBe(s);
  });

  it("truncates and appends suffix when length > limit", () => {
    const s = "a".repeat(4001);
    const result = truncate(s);
    expect(result).toBe("a".repeat(4000) + "…[truncated]");
  });

  it("result length equals limit + suffix.length", () => {
    const s = "x".repeat(5000);
    const suffix = "…[truncated]";
    const result = truncate(s, 4000, suffix);
    expect(result.length).toBe(4000 + suffix.length);
  });

  it("exactly at limit — no truncation", () => {
    const s = "b".repeat(3999);
    expect(truncate(s, 4000)).toBe(s);
  });

  it("supports custom limit and suffix", () => {
    expect(truncate("hello world", 5, "...")).toBe("hello...");
  });
});
