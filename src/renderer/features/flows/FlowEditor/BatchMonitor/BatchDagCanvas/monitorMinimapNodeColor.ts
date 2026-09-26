import type { Node } from '@xyflow/react';
import type { BatchMonitorStageNodeData } from './BatchMonitorStageNode';

/** Status-derived colors for MiniMap node fills — solid RGB for SVG context. */
export function monitorMinimapNodeColor(node: Node): string {
  const data = node.data as BatchMonitorStageNodeData | undefined;
  switch (data?.stage?.status) {
    case 'completed':
      return 'rgb(16, 185, 129)'; // emerald-500
    case 'running':
      return 'rgb(99, 102, 241)'; // indigo-500
    case 'failed':
      return 'rgb(239, 68, 68)'; // red-500
    case 'paused':
      return 'rgb(245, 158, 11)'; // amber-500
    default:
      return 'rgb(115, 115, 115)'; // neutral-600
  }
}
