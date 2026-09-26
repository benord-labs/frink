/**
 * Read-only run sections derived from batch branch chaining: the converging-merge
 * conflict callout and the Base Branch(es) block. Split from RunDetailPanel so the
 * editable-panel component stays focused on its mutation/debounce logic.
 */

import type { ReactElement } from 'react';
import type { BatchStageRunRow } from '../../../../../../../shared/types/flow';
import { deriveRunBranches, isRunMergeConflict } from '../utils';

/** Converging-merge conflict — the run is parked awaiting input, not failed. */
export function RunConflictCallout({ run }: { run: BatchStageRunRow }): ReactElement | null {
  if (!isRunMergeConflict(run)) return null;
  const conflictedFiles = run.conflicted_files ?? [];
  const mergedBranches = run.merged_branches ?? [];
  return (
    <div
      role="status"
      className="flex flex-col gap-1 rounded border border-status-warning/40 bg-status-warning/10 px-2.5 py-2"
    >
      <span className="text-[11px] font-medium text-warning">
        Merge conflict — run paused for input
      </span>
      {run.conflicting_branch && (
        <span className="text-[11px] text-foreground/80 break-all">
          Could not merge <span className="font-medium">{run.conflicting_branch}</span>
        </span>
      )}
      {conflictedFiles.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {conflictedFiles.map((file) => (
            <li key={file} className="text-[11px] font-mono text-foreground/70 break-all">
              {file}
            </li>
          ))}
        </ul>
      )}
      {mergedBranches.length > 0 && (
        <span className="text-[10px] text-muted-foreground/60">
          Merged before the conflict: {mergedBranches.join(', ')}
        </span>
      )}
    </div>
  );
}

/** Base branch(es) the engine created this run's worktree from. */
export function RunBranchSection({ run }: { run: BatchStageRunRow }): ReactElement | null {
  const branchInfo = deriveRunBranches(run.trigger_context);
  if (branchInfo.branches.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wide">
        {branchInfo.branches.length > 1 ? 'Base Branches' : 'Base Branch'}
      </span>
      {branchInfo.branches.map((branch) => (
        <span key={branch} className="text-[12px] text-foreground/80 break-all">
          {branch}
        </span>
      ))}
      {branchInfo.mergeStrategy === 'most-recent' && (
        <span className="text-[10px] text-muted-foreground/50">
          Merged automatically, most-recent first
        </span>
      )}
    </div>
  );
}
