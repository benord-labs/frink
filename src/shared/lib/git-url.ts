/**
 * Git URL normalization utilities (shared between main and renderer)
 *
 * Converts any git remote URL to a canonical form for comparison,
 * handling SSH host aliases (e.g. github.com-work), HTTPS vs SSH, and .git suffixes.
 */

export type GitProvider = 'github' | 'gitlab' | 'bitbucket' | null;

const KNOWN_PROVIDERS: { canonical: string; provider: GitProvider }[] = [
  { canonical: 'github.com', provider: 'github' },
  { canonical: 'gitlab.com', provider: 'gitlab' },
  { canonical: 'bitbucket.org', provider: 'bitbucket' },
];

export const HTTPS_REPO_REGEX =
  /https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/([^/]+)\/([^/?#]+?)(?:[?#].*)?$/;
// Accepts any SSH host (to support aliases like github.com-work)
export const SSH_REPO_REGEX = /git@([^:]+):([^/]+)\/(.+)/;

/**
 * Resolve an SSH host alias to a known provider.
 * Uses strict matching: exact match OR alias with `-` separator
 * where the suffix is a simple label (no dots, preventing subdomain spoofing).
 *
 * Matches: github.com, github.com-work, github.com-personal
 * Rejects: notgithub.com, evil-github.com, github.com.evil.tld, github.com-evil.tld
 */
export function resolveProviderFromHost(
  host: string,
): { canonical: string; provider: GitProvider } | null {
  for (const known of KNOWN_PROVIDERS) {
    if (host === known.canonical) {
      return known;
    }
    // Allow aliases like github.com-work but reject github.com-evil.tld
    if (host.startsWith(`${known.canonical}-`)) {
      const suffix = host.slice(known.canonical.length + 1); // after the "-"
      if (suffix.length > 0 && !suffix.includes('.')) {
        return known;
      }
    }
  }
  return null;
}

/**
 * Normalize a git remote URL to a canonical form for comparison.
 * Strips protocol, SSH aliases, and .git suffix.
 *
 * Examples:
 *   git@github.com-work:owner/repo.git  -> github.com/owner/repo
 *   git@github.com:owner/repo.git       -> github.com/owner/repo
 *   https://github.com/owner/repo.git   -> github.com/owner/repo
 *   https://github.com/owner/repo       -> github.com/owner/repo
 *
 * Returns the raw URL (trimmed, .git stripped) if the host isn't a known provider.
 */
export function normalizeGitRemoteUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;

  // Remove .git suffix for matching
  let cleaned = trimmed;
  if (cleaned.endsWith('.git')) {
    cleaned = cleaned.slice(0, -4);
  }

  // Try HTTPS format
  const httpsMatch = cleaned.match(HTTPS_REPO_REGEX);
  if (httpsMatch) {
    const [, host, owner, repo] = httpsMatch;
    const resolved = resolveProviderFromHost(host);
    if (resolved && owner && repo) {
      return `${resolved.canonical}/${owner}/${repo}`;
    }
  }

  // Try SSH format (supports aliases)
  const sshMatch = cleaned.match(SSH_REPO_REGEX);
  if (sshMatch) {
    const [, host, owner, repo] = sshMatch;
    const resolved = resolveProviderFromHost(host);
    if (resolved && owner && repo) {
      return `${resolved.canonical}/${owner}/${repo}`;
    }
  }

  // Fallback: return cleaned URL
  return cleaned;
}

/**
 * Collect rows whose git remote URL would change after normalization.
 * Pure function shared by SQLite and Neon migration callsites.
 *
 * @param rows   - Array of records with an ID and a raw git remote URL
 * @param getId  - Accessor for the row's primary key
 * @param getUrl - Accessor for the row's git remote URL
 * @returns Only the rows that need updating, with their normalized values
 */
export function collectNormalizedUpdates<T>(
  rows: T[],
  getId: (row: T) => string,
  getUrl: (row: T) => string,
): Array<{ id: string; original: string; normalized: string }> {
  const updates: Array<{ id: string; original: string; normalized: string }> = [];
  for (const row of rows) {
    const original = getUrl(row);
    const normalized = normalizeGitRemoteUrl(original);
    if (normalized !== original) {
      updates.push({ id: getId(row), original, normalized });
    }
  }
  return updates;
}
