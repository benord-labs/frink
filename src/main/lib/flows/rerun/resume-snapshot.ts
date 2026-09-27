import { createHash } from 'node:crypto';
import type { DbNodeRun } from '../../../../shared/types/flow-run';
import type { FlowResumeSnapshot } from '../../../../shared/types/flow-run/resume';

export function resumeSnapshotForNode(
  node: DbNodeRun,
  nodes: DbNodeRun[],
  drivingTask?: FlowResumeSnapshot['drivingTask'],
  plan?: FlowResumeSnapshot['plan'],
): FlowResumeSnapshot {
  return {
    status: node.status,
    nodeOutput: node.node_output ?? null,
    startedAt: node.started_at ?? null,
    completedAt: node.completed_at ?? null,
    attemptIds: nodes
      .filter(
        (entry) =>
          entry.node_id === node.node_id &&
          entry.lane_index === node.lane_index &&
          entry.parent_fan_out_node_run_id === node.parent_fan_out_node_run_id,
      )
      .map((entry) => entry.id),
    drivingTask,
    plan,
  };
}

export function flowResumeActionToken(snapshot: FlowResumeSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
