/**
 * Detects a restart-interrupted flow run so the panel can offer "Re-run from previous node".
 * The interrupted node = the last node_run that didn't finish successfully AND carries the
 * RESTART_INTERRUPTION_REASON marker on its output. Returns null for a user-initiated cancel
 * (no marker, worktree/chat may be gone) or a cleanly-finished run — i.e. when re-run must NOT show.
 */

import type { DbNodeRun } from '../../../../../shared/types/flow-run';
import {
  RESTART_INTERRUPTION_REASON,
  SUPERSEDED_NODE_STATUS,
} from '../../../../../shared/types/flow';

export function findRestartInterruptedNodeRun(nodeRuns: DbNodeRun[]): DbNodeRun | null {
  for (let i = nodeRuns.length - 1; i >= 0; i -= 1) {
    const nr = nodeRuns[i];
    if (
      nr.status === 'completed' ||
      nr.status === 'skipped' ||
      nr.status === SUPERSEDED_NODE_STATUS
    )
      continue;
    const message = (nr.node_output as { error?: { message?: string } } | null)?.error?.message;
    return message === RESTART_INTERRUPTION_REASON ? nr : null;
  }
  return null;
}
