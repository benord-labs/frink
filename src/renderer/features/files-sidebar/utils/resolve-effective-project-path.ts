import { normalizePathForComparison } from '../../../../shared/lib/path-normalization';

export { normalizePathForComparison };

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
