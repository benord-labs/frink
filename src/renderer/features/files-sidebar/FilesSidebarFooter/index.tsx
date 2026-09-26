import { Folder, GitFork } from 'lucide-react';
import type { ReactElement } from 'react';
import { memo } from 'react';
import { isMacOS } from '@/lib/utils/platform';

type Props = {
  projectName: string;
  projectPath: string;
  worktreePath?: string;
  /** Number of selected items (multi-select) */
  selectedCount?: number;
  /** Compact spacing used in split-pane sidebars */
  compact?: boolean;
};

export const FilesSidebarFooter = memo(function FilesSidebarFooter({
  projectName,
  projectPath,
  worktreePath,
  selectedCount,
  compact = false,
}: Props): ReactElement {
  const isMultiSelected = selectedCount != null && selectedCount > 1;
  const worktreeName = worktreePath?.replace(/\\/g, '/').split('/').filter(Boolean).pop();
  const isDistinctProjectPath = Boolean(worktreePath && worktreePath !== projectPath);
  const pathTitle = worktreePath
    ? isDistinctProjectPath
      ? `Worktree: ${worktreePath}\nProject: ${projectPath}`
      : `Worktree: ${worktreePath}`
    : projectPath;

  return (
    <div
      className={
        compact
          ? 'shrink-0 border-t border-border/35 bg-background/15 px-2 py-1 dark:bg-background/10'
          : 'shrink-0 border-t border-border/35 bg-background/15 p-2 pb-1 pt-1 dark:bg-background/10'
      }
    >
      {worktreePath ? (
        <div className="px-1 py-1" title={pathTitle}>
          <div className="flex items-center gap-1.5 text-xs text-primary/80 font-medium">
            <GitFork className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{worktreeName ?? 'worktree'}</span>
            {isMultiSelected && (
              <output
                className="ml-auto shrink-0 text-[10px] font-medium text-foreground/50"
                aria-live="polite"
              >
                {selectedCount} selected
              </output>
            )}
          </div>
          {isDistinctProjectPath && (
            <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground/60">
              <Folder className="h-2.5 w-2.5 shrink-0" aria-hidden />
              <span className="truncate">{projectName}</span>
            </div>
          )}
        </div>
      ) : (
        <div
          className={
            compact
              ? 'flex items-center gap-1.5 px-1 py-1 text-xs text-muted-foreground'
              : 'flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground'
          }
          title={pathTitle}
        >
          <Folder className={compact ? 'h-3 w-3 shrink-0' : 'h-3.5 w-3.5 shrink-0'} aria-hidden />
          <span className="truncate">{projectName}</span>
          {isMultiSelected && (
            <output
              className="ml-auto shrink-0 text-xs font-medium text-foreground/60"
              aria-live="polite"
            >
              {selectedCount} selected
            </output>
          )}
        </div>
      )}
      {isMultiSelected && (
        <div className="px-1 pb-0.5 text-[10px] text-muted-foreground/60">
          {isMacOS()
            ? '⇧↑↓ extend · ⌘A all · Esc clear · ⌫ delete'
            : 'Shift+↑↓ extend · Ctrl+A all · Esc clear · Del delete'}
        </div>
      )}
    </div>
  );
});
