export const WORKING_LINE_CHANGES_QUERY_KEY_PREFIX = [
  'changes',
  'getWorkingFileLineChanges',
] as const;

type WorkingLineChangesQueryMeta = {
  input?: {
    worktreePath?: string;
  };
};

export function hasWorkingLineChangesWorktreeInput(
  meta: unknown,
): meta is { input: { worktreePath: string } } {
  if (!meta || typeof meta !== 'object') {
    return false;
  }

  const input = (meta as WorkingLineChangesQueryMeta).input;
  return Boolean(input && typeof input.worktreePath === 'string');
}
