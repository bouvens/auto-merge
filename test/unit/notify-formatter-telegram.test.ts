import { describe, expect, it } from "vitest";
import { formatTelegram } from "../../src/notify/formatters/telegram.js";

describe("formatTelegram — queue_overflow", () => {
  it("contains bold heading and key + dropped_id in code tags", () => {
    const out = formatTelegram({ kind: "queue_overflow", key: "owner/repo", dropped_id: "abc123" });
    expect(out).toContain("<b>Queue overflow</b>");
    expect(out).toContain("<code>owner/repo</code>");
    expect(out).toContain("<code>abc123</code>");
  });

  it("escapes HTML special chars in key and dropped_id", () => {
    const out = formatTelegram({ kind: "queue_overflow", key: "a&b<c>d", dropped_id: "<x>" });
    expect(out).toContain("a&amp;b&lt;c&gt;d");
    expect(out).toContain("&lt;x&gt;");
  });
});

describe("formatTelegram — cascade_conflict", () => {
  const base = {
    kind: "cascade_conflict" as const,
    run_id: "abcdef1234567890",
    repo: "owner/repo",
    src: "main",
    tgt: "release",
    pr_url: "https://github.com/owner/repo/pull/1",
    author_login: "alice",
  };

  it("contains bold heading, code-wrapped src/tgt, author, and link with raw URL", () => {
    const out = formatTelegram(base);
    expect(out).toContain("<b>Cascade conflict</b>");
    expect(out).toContain("<code>main</code>");
    expect(out).toContain("<code>release</code>");
    expect(out).toContain("alice");
    expect(out).toContain('<a href="https://github.com/owner/repo/pull/1">View PR</a>');
  });

  it("falls back to 'unknown' when author_login is absent", () => {
    const { author_login: _omit, ...noAuthor } = base;
    const out = formatTelegram(noAuthor);
    expect(out).toContain("unknown");
  });

  it("escapes HTML special chars in repo and author_login", () => {
    const out = formatTelegram({ ...base, repo: "a&b", author_login: "user<x>" });
    expect(out).toContain("a&amp;b");
    expect(out).toContain("user&lt;x&gt;");
  });
});

describe("formatTelegram — protection_blocked", () => {
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

  it("contains bold heading, rule in code, and View PR link", () => {
    const out = formatTelegram(base);
    expect(out).toContain("<b>Protection blocked</b>");
    expect(out).toContain("<code>required_status_checks</code>");
    expect(out).toContain('<a href="https://github.com/owner/repo/pull/2">View PR</a>');
  });

  it("falls back to 'unknown' when author_login is absent", () => {
    const { author_login: _omit, ...noAuthor } = base;
    const out = formatTelegram(noAuthor);
    expect(out).toContain("unknown");
  });

  it("escapes HTML special chars in rule", () => {
    const out = formatTelegram({ ...base, rule: "rule<>&x" });
    expect(out).toContain("rule&lt;&gt;&amp;x");
  });
});

describe("formatTelegram — permission_error", () => {
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

  it("contains bold heading, missing_permission and endpoint in code tags, and status", () => {
    const out = formatTelegram(base);
    expect(out).toContain("<b>Permission error</b>");
    expect(out).toContain("<code>contents:write</code>");
    expect(out).toContain("<code>POST /repos/owner/repo/merges</code>");
    expect(out).toContain("403");
  });

  it("contains repo and src/tgt", () => {
    const out = formatTelegram(base);
    expect(out).toContain("owner/repo");
    expect(out).toContain("<code>main</code>");
    expect(out).toContain("<code>dev</code>");
  });

  it("escapes HTML special chars in missing_permission and endpoint", () => {
    const out = formatTelegram({ ...base, missing_permission: "a<b", endpoint: "x>y&z" });
    expect(out).toContain("a&lt;b");
    expect(out).toContain("x&gt;y&amp;z");
  });
});

describe("formatTelegram — config_invalid", () => {
  const base = {
    kind: "config_invalid" as const,
    repo: "owner/repo",
    config_path: ".github/auto-merge.yml",
    zod_error: "Expected string at notifications.slack.channel",
  };

  it("contains bold heading, repo, config_path, and zod_error", () => {
    const out = formatTelegram(base);
    expect(out).toContain("<b>Invalid config</b>");
    expect(out).toContain("owner/repo");
    expect(out).toContain(".github/auto-merge.yml");
    expect(out).toContain("Expected string at notifications.slack.channel");
  });

  it("escapes HTML special chars in zod_error", () => {
    const out = formatTelegram({ ...base, zod_error: "bad<>value&here" });
    expect(out).toContain("bad&lt;&gt;value&amp;here");
  });
});

describe("formatTelegram — empty pr_url omits View PR line", () => {
  it("cascade_conflict + empty pr_url → no View PR link in output", () => {
    const out = formatTelegram({
      kind: "cascade_conflict",
      run_id: "run1",
      repo: "owner/repo",
      src: "main",
      tgt: "release",
      pr_url: "",
    });
    expect(out).not.toContain("View PR");
  });

  it("cascade_conflict + non-empty pr_url → View PR link present", () => {
    const out = formatTelegram({
      kind: "cascade_conflict",
      run_id: "run1",
      repo: "owner/repo",
      src: "main",
      tgt: "release",
      pr_url: "https://github.com/owner/repo/pull/5",
    });
    expect(out).toContain('<a href="https://github.com/owner/repo/pull/5">View PR</a>');
  });

  it("protection_blocked + empty pr_url → no View PR link in output", () => {
    const out = formatTelegram({
      kind: "protection_blocked",
      run_id: "run2",
      repo: "owner/repo",
      src: "main",
      tgt: "dev",
      pr_url: "",
      rule: "required_status_checks",
    });
    expect(out).not.toContain("View PR");
  });

  it("protection_blocked + non-empty pr_url → View PR link present", () => {
    const out = formatTelegram({
      kind: "protection_blocked",
      run_id: "run2",
      repo: "owner/repo",
      src: "main",
      tgt: "dev",
      pr_url: "https://github.com/owner/repo/pull/6",
      rule: "required_status_checks",
    });
    expect(out).toContain('<a href="https://github.com/owner/repo/pull/6">View PR</a>');
  });
});

describe("formatTelegram — truncate behavior", () => {
  it("truncates output exceeding 4000 chars and appends suffix", () => {
    // Use a massive zod_error to exceed 4000 chars
    const out = formatTelegram({
      kind: "config_invalid",
      repo: "owner/repo",
      config_path: ".github/auto-merge.yml",
      zod_error: "x".repeat(5000),
    });
    const suffix = "…[truncated]";
    expect(out.length).toBe(4000 + suffix.length);
    expect(out.endsWith(suffix)).toBe(true);
  });

  it("does not truncate output of exactly 4000 chars", () => {
    // Compute prefix size, then pad zod_error so total hits exactly 4000
    const prefix = "<b>Invalid config</b>\nRepo: <code>r</code>\n<code>p</code>\n";
    const filler = "a".repeat(4000 - prefix.length);
    const out = formatTelegram({
      kind: "config_invalid",
      repo: "r",
      config_path: "p",
      zod_error: filler,
    });
    expect(out.length).toBe(4000);
    expect(out.endsWith("…[truncated]")).toBe(false);
  });

  it("does not truncate output shorter than 4000 chars", () => {
    const out = formatTelegram({ kind: "queue_overflow", key: "repo", dropped_id: "id" });
    expect(out.length).toBeLessThan(4000);
    expect(out.endsWith("…[truncated]")).toBe(false);
  });
});

describe("formatTelegram — double-escape safety", () => {
  it("input '&' produces '&amp;', not '&amp;amp;'", () => {
    const out = formatTelegram({
      kind: "config_invalid",
      repo: "owner/repo",
      config_path: "path",
      zod_error: "a & b",
    });
    expect(out).toContain("a &amp; b");
    expect(out).not.toContain("&amp;amp;");
  });

  it("cascade_conflict PR link href uses raw URL — no escaping of https:// characters", () => {
    const out = formatTelegram({
      kind: "cascade_conflict",
      run_id: "run1",
      repo: "owner/repo",
      src: "main",
      tgt: "release",
      pr_url: "https://github.com/owner/repo/pull/99",
    });
    expect(out).toContain('<a href="https://github.com/owner/repo/pull/99">View PR</a>');
  });
});
