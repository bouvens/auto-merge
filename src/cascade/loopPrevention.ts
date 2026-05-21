export interface BotIdentity {
  login: string;
  email: string;
}

export interface LoopCheckPayload {
  sender: { login: string };
  head_commit: {
    author: { email: string; name?: string; username?: string | null };
    message: string;
  } | null;
}

type Predicate = (p: LoopCheckPayload, bot: BotIdentity) => boolean;

// Object map of predicates — each criterion is independent; all evaluate so reasons[] surfaces every matching signal for diagnostics (D-17).
const CRITERIA: Record<"sender" | "author_email" | "trailer", Predicate> = {
  sender: (p, bot) => p.sender.login === bot.login,
  author_email: (p, bot) =>
    p.head_commit !== null && p.head_commit.author.email.toLowerCase() === bot.email.toLowerCase(),
  // Multiline regex: `Auto-Merge:` anywhere on its own line, case-sensitive per D-17.
  trailer: (p) => p.head_commit !== null && /^Auto-Merge:/m.test(p.head_commit.message),
} as const;

export function checkLoop(
  payload: LoopCheckPayload,
  bot: BotIdentity,
): { skip: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const [key, predicate] of Object.entries(CRITERIA)) {
    if (predicate(payload, bot)) reasons.push(key);
  }
  return { skip: reasons.length > 0, reasons };
}
