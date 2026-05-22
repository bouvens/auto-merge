import { describe, expect, it } from "vitest";
import { formatSlack } from "../../src/notify/formatters/slack.js";

describe("formatSlack — queue_overflow", () => {
  it("contains bold heading and key + dropped_id in code-spans", () => {
    const out = formatSlack({ kind: "queue_overflow", key: "owner/repo", dropped_id: "abc123" });
    expect(out).toContain("*Queue overflow*");
    expect(out).toContain("`owner/repo`");
    expect(out).toContain("`abc123`");
  });

  it("escapes HTML special chars in key and dropped_id", () => {
    const out = formatSlack({ kind: "queue_overflow", key: "a&b<c>d", dropped_id: "<x>" });
    expect(out).toContain("a&amp;b&lt;c&gt;d");
    expect(out).toContain("&lt;x&gt;");
  });
});

describe("formatSlack — cascade_conflict", () => {
  const base = {
    kind: "cascade_conflict" as const,
    run_id: "abcdef1234567890",
    repo: "owner/repo",
    src: "main",
    tgt: "release",
    pr_url: "https://github.com/owner/repo/pull/1",
    author_login: "alice",
  };

  it("contains bold heading, PR link syntax, src/tgt, and author mention", () => {
    const out = formatSlack(base);
    expect(out).toContain("*Cascade conflict*");
    expect(out).toContain("<https://github.com/owner/repo/pull/1|");
    expect(out).toContain("|");
    expect(out).toContain("`main`");
    expect(out).toContain("`release`");
    expect(out).toContain("@alice");
  });

  it("contains run_id short form (first 8 chars)", () => {
    const out = formatSlack(base);
    expect(out).toContain("abcdef12");
  });

  it("falls back to 'unknown' when author_login is absent", () => {
    const { author_login: _omit, ...noAuthor } = base;
    const out = formatSlack(noAuthor);
    expect(out).toContain("unknown");
  });

  it("escapes HTML special chars in repo name (display portion only)", () => {
    const out = formatSlack({ ...base, repo: "owner/a&b" });
    expect(out).toContain("a&amp;b");
  });
});

describe("formatSlack — protection_blocked", () => {
  const base = {
    kind: "protection_blocked" as const,
    run_id: "aaaa1111bbbb2222",
    repo: "owner/repo",
    src: "main",
    tgt: "dev",
    pr_url: "https://github.com/owner/repo/pull/2",
    rule: "required_status_checks",
    author_login: "bob",
  };

  it("contains bold heading and rule in code-span", () => {
    const out = formatSlack(base);
    expect(out).toContain("*Protection blocked*");
    expect(out).toContain("`required_status_checks`");
  });

  it("contains repo, src→tgt and PR link", () => {
    const out = formatSlack(base);
    expect(out).toContain("`main`");
    expect(out).toContain("`dev`");
    expect(out).toContain("<https://github.com/owner/repo/pull/2|");
  });

  it("falls back to 'unknown' when author_login is absent", () => {
    const { author_login: _omit, ...noAuthor } = base;
    const out = formatSlack(noAuthor);
    expect(out).toContain("unknown");
  });

  it("escapes HTML special chars in rule", () => {
    const out = formatSlack({ ...base, rule: "rule<>&x" });
    expect(out).toContain("rule&lt;&gt;&amp;x");
  });
});

describe("formatSlack — permission_error", () => {
  const base = {
    kind: "permission_error" as const,
    run_id: "cccc3333dddd4444",
    repo: "owner/repo",
    src: "main",
    tgt: "dev",
    endpoint: "POST /repos/owner/repo/merges",
    status: 403,
    missing_permission: "contents:write",
  };

  it("contains bold heading, missing_permission and endpoint in code-spans, and status as number", () => {
    const out = formatSlack(base);
    expect(out).toContain("*Permission error*");
    expect(out).toContain("`contents:write`");
    expect(out).toContain("`POST /repos/owner/repo/merges`");
    expect(out).toContain("403");
  });

  it("contains repo and src→tgt", () => {
    const out = formatSlack(base);
    expect(out).toContain("owner/repo");
    expect(out).toContain("`main`");
    expect(out).toContain("`dev`");
  });

  it("escapes HTML special chars in missing_permission and endpoint", () => {
    const out = formatSlack({ ...base, missing_permission: "a<b", endpoint: "x>y&z" });
    expect(out).toContain("a&lt;b");
    expect(out).toContain("x&gt;y&amp;z");
  });
});

describe("formatSlack — config_invalid", () => {
  const base = {
    kind: "config_invalid" as const,
    repo: "owner/repo",
    config_path: ".github/auto-merge.yml",
    zod_error: "Expected string at notifications.slack.channel",
  };

  it("contains bold heading, repo, config_path, and zod_error", () => {
    const out = formatSlack(base);
    expect(out).toContain("*Invalid config*");
    expect(out).toContain("owner/repo");
    expect(out).toContain(".github/auto-merge.yml");
    expect(out).toContain("Expected string at notifications.slack.channel");
  });

  it("escapes HTML special chars in zod_error", () => {
    const out = formatSlack({ ...base, zod_error: "bad<>value&here" });
    expect(out).toContain("bad&lt;&gt;value&amp;here");
  });
});

describe("formatSlack — link syntax correctness", () => {
  it("cascade_conflict PR link uses raw URL without escaping angle brackets or pipe", () => {
    const out = formatSlack({
      kind: "cascade_conflict",
      run_id: "run1",
      repo: "owner/repo",
      src: "main",
      tgt: "release",
      pr_url: "https://github.com/owner/repo/pull/99",
    });
    // Must contain raw Slack link syntax with < and | characters
    expect(out).toMatch(/<https:\/\/github\.com\/owner\/repo\/pull\/99\|/);
  });
});
