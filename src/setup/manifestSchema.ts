import type { Env } from "../env.js";

export interface Manifest {
  name: string;
  url: string;
  hook_attributes: { url: string };
  redirect_url: string;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
  state: string;
}

type ManifestEnv = Pick<Env, "SETUP_APP_NAME" | "SETUP_PUBLIC_URL">;

// Locked scope: minimum permissions for cascade merge; broader scopes are forbidden by project constraints.
const DEFAULT_PERMISSIONS: Record<string, string> = {
  contents: "write",
  pull_requests: "write",
  checks: "write",
  metadata: "read",
};

const DEFAULT_EVENTS: string[] = [
  "push",
  "pull_request",
  "installation",
  "installation_repositories",
  "check_run",
];

// org influences only the form `action` URL handled by the form renderer; manifest body itself does not carry it.
export function buildManifest(env: ManifestEnv, state: string, _org?: string): Manifest {
  if (!env.SETUP_PUBLIC_URL) {
    throw new Error("SETUP_PUBLIC_URL required to build a GitHub App manifest");
  }
  const base = env.SETUP_PUBLIC_URL;
  return {
    name: env.SETUP_APP_NAME,
    url: base,
    hook_attributes: { url: `${base}/webhook` },
    redirect_url: `${base}/setup/callback`,
    public: false,
    default_permissions: { ...DEFAULT_PERMISSIONS },
    default_events: [...DEFAULT_EVENTS],
    state,
  };
}
