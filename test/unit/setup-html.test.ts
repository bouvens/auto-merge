import { describe, expect, it } from "vitest";
import { escapeHtml, jsonForHtmlAttr } from "../../src/setup/html.js";

describe("setup/html.escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("&")).toBe("&amp;");
  });

  it("escapes angle brackets in a script tag", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes double quote", () => {
    expect(escapeHtml('"')).toBe("&quot;");
  });

  it("escapes single quote as &#39;", () => {
    expect(escapeHtml("'")).toBe("&#39;");
  });

  it("returns plain text unchanged (no false positives)", () => {
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("is intentionally non-idempotent on & — caller must escape exactly once", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml(escapeHtml("&"))).toBe("&amp;amp;");
  });
});

describe("setup/html.jsonForHtmlAttr", () => {
  it("escapes embedded double quotes so result can be wrapped in value=\"...\"", () => {
    const out = jsonForHtmlAttr({ x: '"y"' });
    expect(out).not.toContain('"y"');
    expect(out).toContain("&quot;");
  });

  it("escapes < and > inside string values", () => {
    const out = jsonForHtmlAttr({ x: "<svg>" });
    expect(out).toContain("&lt;svg&gt;");
    expect(out).not.toContain("<svg>");
  });

  it("does not contain a raw double quote that would break the surrounding attribute", () => {
    const out = jsonForHtmlAttr({ a: 1, b: "two" });
    expect(out.includes('"')).toBe(false);
  });
});
