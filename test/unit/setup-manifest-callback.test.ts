import { describe, expect, it } from "vitest";
import { redactTail, renderSuccessPage } from "../../src/setup/manifestCallback.js";

describe("redactTail", () => {
  it("returns ****<last N> for normal input", () => {
    expect(redactTail("supersecretabcd", 4)).toBe("****abcd");
  });

  it("returns **** when input is shorter than the tail length (no source bytes leak)", () => {
    expect(redactTail("ab", 4)).toBe("****");
  });

  it("returns **** when input is undefined", () => {
    expect(redactTail(undefined, 4)).toBe("****");
  });

  it("returns **** when input is empty string", () => {
    expect(redactTail("", 4)).toBe("****");
  });
});

describe("renderSuccessPage", () => {
  const baseInfo = {
    appId: 42,
    webhookSecretTail: "****abcd",
    pemTail: "****EFGH",
    slug: "auto-merge-test",
    htmlUrl: "https://github.com/apps/auto-merge-test",
  };

  it("starts with <!doctype html>", () => {
    const html = renderSuccessPage(baseInfo);
    expect(html.toLowerCase().startsWith("<!doctype html>")).toBe(true);
  });

  it("contains the literal APP_ID integer text", () => {
    const html = renderSuccessPage(baseInfo);
    expect(html).toMatch(/\b42\b/);
  });

  it("contains the redacted webhook secret tail and PEM tail literally", () => {
    const html = renderSuccessPage(baseInfo);
    expect(html).toContain("****abcd");
    expect(html).toContain("****EFGH");
  });

  it("contains a download form pointing at /setup/credentials.env (method=get)", () => {
    const html = renderSuccessPage(baseInfo);
    expect(html).toContain('action="/setup/credentials.env"');
    expect(html).toMatch(/<form\b[^>]*method="get"/);
  });

  it("negative containment: raw PEM body and raw webhook secret never appear in output", () => {
    // Construct redacted tails as the handler would, then assert HTML does NOT contain the raw secrets.
    const rawPem =
      "-----BEGIN RSA PRIVATE KEY-----\nDEADBEEFCAFEBABE0123456789ABCDEF\n-----END RSA PRIVATE KEY-----\n";
    const rawWebhook = "topsecret_full_string";
    const html = renderSuccessPage({
      appId: 99,
      webhookSecretTail: redactTail(rawWebhook, 4),
      pemTail: "****EFGH",
    });
    expect(html).not.toContain("DEADBEEFCAFEBABE");
    expect(html).not.toContain(rawWebhook);
    // Tail itself ("ring") is allowed; but only via the redactTail value.
    expect(html).toContain(redactTail(rawWebhook, 4));
  });

  it("is pure — same args produce byte-identical output", () => {
    expect(renderSuccessPage(baseInfo)).toBe(renderSuccessPage(baseInfo));
  });
});
