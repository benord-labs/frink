import type { DbFlowRunWithNodeRuns } from '../../../../../shared/types/flow-run';

/**
 * True when expanded run detail is aligned with the list selection and safe to paint on the canvas.
 * Rejects stale React Query rows after switching expanded run (run.id !== expandedRunId).
 */
export function shouldPaintExpandedRunOnCanvas(
  expandedRunId: string | null | undefined,
  run: DbFlowRunWithNodeRuns | undefined | null,
): run is DbFlowRunWithNodeRuns {
  if (expandedRunId == null || !run) return false;
  if (run.id !== expandedRunId) return false;
  if (run.status === 'running' || run.status === 'paused') return false;
  return true;
}
