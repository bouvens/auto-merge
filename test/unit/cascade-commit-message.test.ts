import { describe, expect, it } from "vitest";
import {
  buildCommitMessage,
  type CompareData,
} from "../../src/cascade/commitMessage.js";

describe("buildCommitMessage", () => {
  it("N=1 happy path produces exact title/body/trailer", () => {
    const compare: CompareData = {
      total_commits: 1,
      commits: [
        { sha: "abcdef1234567", commit: { message: "feat: add login" } },
      ],
    };
    const out = buildCommitMessage({
      src: "main",
      tgt: "release",
      runId: "abc-uuid",
      compare,
    });
    expect(out).toBe(
      "Auto-merge main into release\n\n1 commit abcdef1 (feat: add login)\n\nAuto-Merge: cascade abc-uuid",
    );
  });

  it("N=3 produces `3 commits from {first} ({s1}) to {last} ({s3})`", () => {
    const compare: CompareData = {
      total_commits: 3,
      commits: [
        { sha: "1111111aaaa", commit: { message: "feat: one" } },
        { sha: "2222222bbbb", commit: { message: "feat: two" } },
        { sha: "3333333cccc", commit: { message: "feat: three" } },
      ],
    };
    const out = buildCommitMessage({
      src: "main",
      tgt: "release",
      runId: "rid-1",
      compare,
    });
    expect(out).toBe(
      "Auto-merge main into release\n\n3 commits from 1111111 (feat: one) to 3333333 (feat: three)\n\nAuto-Merge: cascade rid-1",
    );
  });

  it("subject of 100 chars truncates to 72 visible chars ending with ellipsis", () => {
    const longSubject = "x".repeat(100);
    const compare: CompareData = {
      total_commits: 1,
      commits: [{ sha: "abcdef1234567", commit: { message: longSubject } }],
    };
    const out = buildCommitMessage({
      src: "main",
      tgt: "dev",
      runId: "r",
      compare,
    });
    // The truncated subject appears inside parentheses
    const truncated = `${"x".repeat(71)}…`;
    expect(truncated.length).toBe(72);
    expect(out).toContain(`(${truncated})`);
    expect(out).not.toContain("x".repeat(73));
  });

  it("multi-line commit message uses only first line for subject", () => {
    const compare: CompareData = {
      total_commits: 1,
      commits: [
        {
          sha: "abcdef1234567",
          commit: { message: "feat: top line\n\nbody paragraph\nmore body" },
        },
      ],
    };
    const out = buildCommitMessage({
      src: "main",
      tgt: "dev",
      runId: "r",
      compare,
    });
    expect(out).toContain("(feat: top line)");
    expect(out).not.toContain("body paragraph");
  });

  it("total_commits=0 throws", () => {
    const compare: CompareData = { total_commits: 0, commits: [] };
    expect(() =>
      buildCommitMessage({ src: "main", tgt: "dev", runId: "r", compare }),
    ).toThrow(/total_commits=0/);
  });

  it("empty commits[] with total_commits>0 throws", () => {
    const compare: CompareData = { total_commits: 2, commits: [] };
    expect(() =>
      buildCommitMessage({ src: "main", tgt: "dev", runId: "r", compare }),
    ).toThrow(/empty commits\[\]/);
  });

  it("trailer is always last with one preceding blank line", () => {
    const compare: CompareData = {
      total_commits: 1,
      commits: [{ sha: "abcdef1234567", commit: { message: "x" } }],
    };
    const out = buildCommitMessage({
      src: "main",
      tgt: "dev",
      runId: "uuid-final",
      compare,
    });
    const lines = out.split("\n");
    expect(lines[lines.length - 1]).toBe("Auto-Merge: cascade uuid-final");
    expect(lines[lines.length - 2]).toBe("");
    // No trailing newline
    expect(out.endsWith("\n")).toBe(false);
  });
});
