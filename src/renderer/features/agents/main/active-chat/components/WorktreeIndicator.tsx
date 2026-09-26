/**
 * WorktreeIndicator - Shows a "Worktree" label with icon + tooltip
 * Used in branch bars to indicate the chat runs in an isolated git worktree.
 */

import { GitFork } from 'lucide-react';
import { memo } from 'react';
import { LeafLabel } from '@/components/ui/leaf-label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type WorktreeIndicatorProps = {
  worktreeLabel: string;
  worktreePath?: string | null;
  /** Set when this chip stands in for the worktree picker because the chat is busy. */
  lockedReason?: string;
};

const WORKTREE_LABEL_PREFIX_REGEX = /^WT:\s*/i;

export const WorktreeIndicator = memo(function WorktreeIndicator({
  worktreeLabel,
  worktreePath,
  lockedReason,
}: WorktreeIndicatorProps) {
  const worktreeName = worktreeLabel.replace(WORKTREE_LABEL_PREFIX_REGEX, '');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex h-6 min-w-0 items-center gap-1.5 text-xs"
          aria-label={`Worktree: ${worktreeName}`}
        >
          <GitFork className="h-3 w-3 shrink-0 text-muted-foreground/80" aria-hidden />
          <LeafLabel text={worktreeName} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        <div className="flex flex-col gap-1">
          <span>Worktree: {worktreeName}</span>
          {worktreePath ? <span className="text-muted-foreground">{worktreePath}</span> : null}
          {lockedReason ? <span className="text-muted-foreground">{lockedReason}</span> : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
});
