import { stringify } from "yaml";
import { ConfigSchema } from "../config/schema.js";

// Defensive whitelist regexes for inputs that flow from webhook payload into YAML/Markdown templates.
const GIT_REF_RE = /^[A-Za-z0-9._/-]{1,255}$/;
const GH_LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;

function validateBranchName(defaultBranch: string): void {
  if (!GIT_REF_RE.test(defaultBranch) || defaultBranch.includes("..")) {
    throw new Error(`invalid default branch: ${defaultBranch}`);
  }
}

export function buildYmlConfig(defaultBranch: string): string {
  validateBranchName(defaultBranch);
  const config = {
    main_branch: defaultBranch,
    dev_branch: "dev",
  };
  // Round-trip invariant: template must remain valid as ConfigSchema evolves.
  ConfigSchema.parse(config);
  const yaml = stringify(config);
  return `# auto-merge bootstrap configuration\n# Uncomment release_branch if you have a staging/release branch between source and dev:\n# release_branch: release\n\n${yaml}`;
}

// GitHub Actions expressions `${{ ... }}` are kept literal by escaping opening braces inside this JS template literal.
export const DISPATCH_WORKFLOW_YML = `name: auto-merge dispatch
on:
  workflow_dispatch:
    inputs:
      source_sha:
        description: SHA to cascade from source branch
        required: true
jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -X POST "$APP_URL/dispatch" \\
            -H "Authorization: Bearer \${{ secrets.AUTO_MERGE_TOKEN }}" \\
            -d '{"sha":"\${{ inputs.source_sha }}"}'
        env:
          APP_URL: \${{ vars.AUTO_MERGE_APP_URL }}
`;

export function buildPrBody(args: {
  owner: string;
  repo: string;
  defaultBranch: string;
  senderLogin?: string;
  publicUrl?: string;
}): string {
  const { owner, repo, defaultBranch, senderLogin, publicUrl } = args;
  const mentionPart = senderLogin && GH_LOGIN_RE.test(senderLogin) ? `@${senderLogin} ` : "";
  const diagnoseLink = publicUrl
    ? `\n\n**Diagnose:** [${publicUrl}/diagnose/${owner}/${repo}](${publicUrl}/diagnose/${owner}/${repo})`
    : "";
  return `${mentionPart}This PR bootstraps auto-merge cascade configuration for \`${owner}/${repo}\`.

## What this does
Adds \`.github/auto-merge.yml\` (cascade config — default branch is \`${defaultBranch}\`, dev branch is \`dev\`) and a dispatch workflow.

## Before merging — checklist
- [ ] If you have a staging/release branch between \`${defaultBranch}\` and \`dev\`, uncomment \`release_branch\` in \`.github/auto-merge.yml\`.
- [ ] If you want Slack/Telegram conflict alerts, add \`notifications.slack.channel\` / \`notifications.telegram.chat_id\` to the yml.
- [ ] Verify that \`${defaultBranch}\` and \`dev\` branches both exist in this repository.${diagnoseLink}
`;
}
