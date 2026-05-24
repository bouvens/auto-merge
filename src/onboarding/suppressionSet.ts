const TTL_MS = 10 * 60 * 1000;

const map = new Map<number, number>();

export function markOnboarding(installationId: number): void {
  map.set(installationId, Date.now() + TTL_MS);
}

// Lazy-purge invariant: expired entries are removed on read — no scheduled timer required.
export function isOnboarding(installationId: number): boolean {
  const expiresAt = map.get(installationId);
  if (expiresAt === undefined) return false;
  if (Date.now() >= expiresAt) {
    map.delete(installationId);
    return false;
  }
  return true;
}

export function _reset(): void {
  map.clear();
}
