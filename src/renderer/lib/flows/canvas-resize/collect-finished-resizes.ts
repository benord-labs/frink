/**
 * Turns React Flow's resizer change stream into committed Fan Out resizes, reading only the change
 * batches themselves so a resize end never depends on whether React has rendered the last step.
 */

import type { NodeChange, XYPosition } from '@xyflow/react';

/** Positions moved so far by each in-flight resize, keyed by the resized node's id. */
export type ResizeMoves = Map<string, Map<string, XYPosition>>;

export type FinishedResize = {
  id: string;
  size: { width: number; height: number };
  positions: Array<{ id: string; position: XYPosition }>;
};

/** Top/left resizes emit the container's and its children's position changes in the same batch. */
function recordMoves(changes: NodeChange[], moved: Map<string, XYPosition>) {
  for (const change of changes) {
    if (change.type === 'position' && change.position) moved.set(change.id, change.position);
  }
  return moved;
}

/**
 * Updates `moves` from one change batch and returns the resizes it finished. Only the resizer sets
 * `resizing`; an end with no prior `resizing: true` is a click on a handle and commits nothing.
 */
export function collectFinishedResizes(
  changes: NodeChange[],
  moves: ResizeMoves,
): FinishedResize[] {
  const finished: FinishedResize[] = [];
  for (const change of changes) {
    if (change.type !== 'dimensions' || change.resizing === undefined) continue;
    const moved = moves.get(change.id);
    if (change.resizing) {
      moves.set(change.id, recordMoves(changes, moved ?? new Map()));
      continue;
    }
    moves.delete(change.id);
    if (!moved || !change.dimensions) continue;
    const positions = [...moved].map(([id, position]) => ({ id, position }));
    finished.push({ id: change.id, size: change.dimensions, positions });
  }
  return finished;
}
