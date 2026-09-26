export type ProjectSelectionCandidate = {
  id: string;
  name: string;
  path: string;
  gitRemoteUrl?: string | null;
  gitProvider?: string | null;
  gitOwner?: string | null;
  gitRepo?: string | null;
  /** Last activity in any of the project's chats; null when it has none. */
  lastActiveAt?: Date | null;
};

export function isProjectSelectionCandidate(value: unknown): value is ProjectSelectionCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.path === 'string'
  );
}
