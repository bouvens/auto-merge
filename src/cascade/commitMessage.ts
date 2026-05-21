export interface CompareData {
  total_commits: number;
  commits: Array<{ sha: string; commit: { message: string } }>;
}

// 72-char cap preserves git log readability — typical terminal width is 80, leave room for graph chars.
const SUBJECT_MAX = 72;

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function truncateSubject(msg: string): string {
  // Discard body lines — only the first line is the conventional subject.
  const firstLine = msg.split("\n")[0] ?? "";
  if (firstLine.length <= SUBJECT_MAX) return firstLine;
  // Single ellipsis (U+2026) counts as one visible char, so total = SUBJECT_MAX.
  return `${firstLine.slice(0, SUBJECT_MAX - 1)}…`;
}

function composeBody(compare: CompareData): string {
  // Fail-closed: orchestrator must filter ahead_by=0 before reaching here (D-12).
  if (compare.total_commits === 0) {
    throw new Error(
      "buildCommitMessage: total_commits=0 — skip should have been detected before merge call",
    );
  }
  // Defensive: GitHub compare must return commits[] when total_commits>0; treat mismatch as a bug.
  if (compare.commits.length === 0) {
    throw new Error("buildCommitMessage: empty commits[] with total_commits>0");
  }
  if (compare.total_commits === 1) {
    const c = compare.commits[0]!;
    return `1 commit ${shortSha(c.sha)} (${truncateSubject(c.commit.message)})`;
  }
  const first = compare.commits[0]!;
  const last = compare.commits[compare.commits.length - 1]!;
  return `${compare.total_commits} commits from ${shortSha(first.sha)} (${truncateSubject(
    first.commit.message,
  )}) to ${shortSha(last.sha)} (${truncateSubject(last.commit.message)})`;
}

export function buildCommitMessage(input: {
  src: string;
  tgt: string;
  runId: string;
  compare: CompareData;
}): string {
  const title = `Auto-merge ${input.src} into ${input.tgt}`;
  const body = composeBody(input.compare);
  const trailer = `Auto-Merge: cascade ${input.runId}`;
  return `${title}\n\n${body}\n\n${trailer}`;
}
