const BACKSLASH_REGEX = /\\/g;
const TRAILING_SLASHES_REGEX = /\/+$/;
const WINDOWS_DRIVE_PATH_REGEX = /^[a-z]:\//i;

export function normalizePathForComparison(value: string | null | undefined): string | null {
  const normalized =
    value?.replace(BACKSLASH_REGEX, '/').replace(TRAILING_SLASHES_REGEX, '') ?? null;
  // Windows paths are case-insensitive; normalize drive/casing for robust comparisons.
  if (normalized && WINDOWS_DRIVE_PATH_REGEX.test(normalized)) {
    return normalized.toLowerCase();
  }
  return normalized;
}

export function resolveScopedChatWorktreePath(params: {
  activeChatId?: string | null;
  queriedChatId?: string | null;
  queriedWorktreePath?: string | null;
  fallbackWorktreePath?: string | null;
}): string | undefined {
  const { activeChatId, queriedChatId, queriedWorktreePath, fallbackWorktreePath } = params;
  if (!queriedChatId || queriedChatId !== activeChatId) {
    return fallbackWorktreePath ?? undefined;
  }
  return queriedWorktreePath ?? fallbackWorktreePath ?? undefined;
}

export function resolveActiveWorktreePath(params: {
  rawWorktreePath?: string | null;
  selectedProjectPath?: string | null;
}): string | undefined {
  const { rawWorktreePath, selectedProjectPath } = params;
  const normalizedRawWorktreePath = normalizePathForComparison(rawWorktreePath);
  const normalizedProjectPath = normalizePathForComparison(selectedProjectPath);

  if (!normalizedRawWorktreePath) return undefined;
  if (normalizedProjectPath && normalizedRawWorktreePath === normalizedProjectPath) {
    return undefined;
  }

  return rawWorktreePath ?? undefined;
}

export function resolveEffectiveProjectPath(params: {
  worktreePath?: string | null;
  selectedProjectPath?: string | null;
}): string | undefined {
  const { worktreePath, selectedProjectPath } = params;
  return worktreePath ?? selectedProjectPath ?? undefined;
}
