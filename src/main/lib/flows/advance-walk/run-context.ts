/**
 * What an advancing run needs to know about itself: the flow it belongs to, its parsed graph and
 * the trigger payload. Loaded per advance from the run's own version.
 */

import { getDatabase } from '../../db';
import { getFlowRun } from '../../db/repos/flow-runs';
import { getVersion } from '../../db/repos/flow-versions';
import { getFlowById } from '../../db/repos/flows';
import type { DispatchContext } from '../dispatch/types';
import { type ParsedFlowGraph, parseGraph } from '../graph';
import { isRecord } from '../rerun/claim-flags';

type FlowMeta = { flowId: string; flowName: string; batchId?: string };

export type RunContext = {
  meta: FlowMeta;
  graph: ParsedFlowGraph;
  triggerContext: DispatchContext['triggerContext'];
};

export async function loadRunContext(flowRunId: string): Promise<RunContext | null> {
  const db = getDatabase();
  const run = await getFlowRun(db, flowRunId);
  if (!run) return null;
  const version = await getVersion(db, run.flowVersionId);
  if (!version) return null;
  const flow = await getFlowById(db, version.flowId);
  if (!flow) return null;
  return {
    // batchId marks a batch-member run so its events can be told apart from
    // standalone runs (the renderer keeps members individually silent).
    meta: { flowId: flow.id, flowName: flow.name, batchId: run.batchId ?? undefined },
    graph: parseGraph(version.graph),
    triggerContext: isRecord(run.triggerContext) ? run.triggerContext : null,
  };
}
