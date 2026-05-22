import type { Octokit } from "@octokit/core";
import { LRUCache } from "lru-cache";
import { LineCounter, parseDocument } from "yaml";
import { createFailureCheckRun } from "../cascade/checkRun.js";
import type { NotificationChannel } from "../notify/channel.js";
import { type Config, ConfigSchema } from "./schema.js";

export interface ConfigError {
  line: number;
  col: number;
  message: string;
}

// Immutable per (owner, repo, sha) — same SHA always yields same content, no invalidation needed (D-16).
const cache = new LRUCache<string, Config>({
  max: 500,
  ttl: 3_600_000,
  ttlAutopurge: true,
});

// Last-known config per repo — stale-ok for notification channel getConfig lookups (D-16 option A).
const repoConfigCache = new Map<string, Config>();

export function getRepoConfig(owner: string, repo: string): Config | undefined {
  return repoConfigCache.get(`${owner}/${repo}`);
}

export function parseConfig(text: string): { config?: Config; errors: ConfigError[] } {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { prettyErrors: true, lineCounter });

  if (doc.errors.length > 0) {
    const errors: ConfigError[] = doc.errors.map((e) => {
      // linePos may be set directly on the error; fall back to lineCounter for byte-offset errors.
      const lp = e.linePos?.[0] ?? lineCounter.linePos(e.pos[0] ?? 0);
      return { line: lp.line, col: lp.col, message: e.message };
    });
    return { errors };
  }

  const parsed = ConfigSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    // Zod lacks source position; embed field path in message so Check Run summary is still actionable.
    return {
      errors: parsed.error.issues.map((i) => ({
        line: 1,
        col: 1,
        message: `${i.path.join(".") || "(root)"}: ${i.message}`,
      })),
    };
  }

  return { config: parsed.data, errors: [] };
}

export async function loadConfig(deps: {
  octokit: Octokit;
  owner: string;
  repo: string;
  sha: string;
  installation_id: number;
  notify?: NotificationChannel;
}): Promise<{ config?: Config; errors: ConfigError[] }> {
  const key = `${deps.owner}/${deps.repo}@${deps.sha}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return { config: cached, errors: [] };
  }

  let text: string;
  try {
    // octokit.request avoids coupling to a specific @octokit/rest plugin version from Probot.
    const resp = await deps.octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: deps.owner,
      repo: deps.repo,
      path: ".github/auto-merge.yml",
      ref: deps.sha,
    });
    const data = resp.data as { content?: string; encoding?: string };
    if (!data.content || data.encoding !== "base64") {
      const errors: ConfigError[] = [
        { line: 1, col: 1, message: "config file not found or not a file" },
      ];
      await createInvalidConfigCheckRun(deps, errors);
      void deps.notify?.notify({
        kind: "config_invalid",
        installation_id: deps.installation_id,
        repo: `${deps.owner}/${deps.repo}`,
        config_path: ".github/auto-merge.yml",
        zod_error: errors.map((e) => `L${e.line}:${e.col} ${e.message}`).join("; "),
      }).catch(() => undefined);
      return { errors };
    }
    // GitHub encodes file content as base64 with embedded newlines — strip before decoding.
    text = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errors: ConfigError[] = [
      { line: 1, col: 1, message: `failed to fetch config: ${message}` },
    ];
    await createInvalidConfigCheckRun(deps, errors);
    void deps.notify?.notify({
      kind: "config_invalid",
      installation_id: deps.installation_id,
      repo: `${deps.owner}/${deps.repo}`,
      config_path: ".github/auto-merge.yml",
      zod_error: errors.map((e) => `L${e.line}:${e.col} ${e.message}`).join("; "),
    }).catch(() => undefined);
    return { errors };
  }

  const result = parseConfig(text);
  if (result.errors.length > 0) {
    await createInvalidConfigCheckRun(deps, result.errors);
    void deps.notify?.notify({
      kind: "config_invalid",
      installation_id: deps.installation_id,
      repo: `${deps.owner}/${deps.repo}`,
      config_path: ".github/auto-merge.yml",
      zod_error: result.errors.map((e) => `L${e.line}:${e.col} ${e.message}`).join("; "),
    }).catch(() => undefined);
    return result;
  }

  cache.set(key, result.config!);
  repoConfigCache.set(`${deps.owner}/${deps.repo}`, result.config!);
  return result;
}

// Delegates to shared helper — failure-Check-Run shape is identical across config (CFG-05) and cascade (OBS-01) so we keep one POST path with error swallowing.
async function createInvalidConfigCheckRun(
  deps: { octokit: Octokit; owner: string; repo: string; sha: string },
  errors: ConfigError[],
): Promise<void> {
  await createFailureCheckRun(
    { octokit: deps.octokit, owner: deps.owner, repo: deps.repo },
    {
      head_sha: deps.sha,
      name: "auto-merge / config",
      title: "Invalid .github/auto-merge.yml",
      summary: errors.map((e) => `- L${e.line}:${e.col} — ${e.message}`).join("\n"),
    },
  );
}
