export function deriveWorktreeLabel(worktreePath: string | null | undefined): {
  worktreeName: string | null;
  worktreeLabel: string;
} {
  const worktreeName = worktreePath?.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? null;
  const worktreeLabel = worktreeName ? `WT: ${worktreeName}` : 'WT';
  return { worktreeName, worktreeLabel };
}
