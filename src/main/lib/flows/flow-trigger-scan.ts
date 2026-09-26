/**
 * The one walk over enabled flows and their latest parsed graphs, shared by the schedule poll and
 * the webhook-event handler. Skips disabled flows, flows with no saved version, unparseable graphs.
 */

import type { getDatabase } from '../db';
import { getLatestVersion } from '../db/repos/flow-versions';
import { listFlows } from '../db/repos/flows';
import type { Flow } from '../db/schema';
import { type ParsedFlowGraph, parseGraph } from './graph';

type Db = ReturnType<typeof getDatabase>;

export type EnabledFlowGraph = { flow: Flow; graph: ParsedFlowGraph };

export async function listEnabledFlowGraphs(db: Db): Promise<EnabledFlowGraph[]> {
  const flows = await listFlows(db);
  const result: EnabledFlowGraph[] = [];
  for (const flow of flows) {
    if (!flow.isEnabled) continue;
    const version = await getLatestVersion(db, flow.id);
    if (!version) continue;
    try {
      result.push({ flow, graph: parseGraph(version.graph) });
    } catch {
      // Unparseable graph — skip.
    }
  }
  return result;
}
