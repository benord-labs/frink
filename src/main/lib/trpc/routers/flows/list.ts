import { z } from 'zod';
import { getDatabase } from '../../../db';
import {
  getActiveFlowDrivingStatusByRun,
  getLatestRunsForFlows,
  listFlowRunsForFlow,
} from '../../../db/repos/flow-runs';
import { getLatestVersion } from '../../../db/repos/flow-versions';
import { listFlows } from '../../../db/repos/flows';
import { toDbFlow, toDbFlowRun } from '../../../flows/adapters';
import {
  type FlowAdmissionRun,
  type FlowRunAdmissionSnapshot,
  flowRunAdmissionSnapshotsForRuns,
  queuedRunsForFlows,
} from '../../../flows/admission/visibility';
import { publicProcedureRaw } from '../../index';

export function flowGraphMeta(version: { graph: unknown } | null) {
  if (!version || typeof version.graph !== 'object' || version.graph === null) {
    return { nodeCount: null, triggerType: null };
  }
  const nodes = (version.graph as { nodes?: { blockType: string }[] }).nodes;
  return { nodeCount: nodes?.length ?? null, triggerType: nodes?.[0]?.blockType ?? null };
}

function latestRunMeta(
  run: FlowAdmissionRun | null,
  snapshot: FlowRunAdmissionSnapshot | undefined,
) {
  if (!run) return { latestRun: null, latestRunAdmission: null };
  return {
    latestRun: { ...run, status: snapshot?.runStatus ?? run.status },
    latestRunAdmission: snapshot?.admission ?? null,
  };
}

export function createFlowListProcedures() {
  return {
    list: publicProcedureRaw
      .input(z.object({ projectId: z.string().min(1).nullable().optional() }).optional())
      .query(async ({ input }) => {
        const db = getDatabase();
        const rows = await listFlows(db, input?.projectId);
        const flowIds = rows.map((row) => row.id);
        const latestRuns = await getLatestRunsForFlows(db, flowIds);
        for (const [flowId, run] of queuedRunsForFlows(db, flowIds)) {
          if (!latestRuns.has(flowId)) latestRuns.set(flowId, run);
        }
        const snapshots = flowRunAdmissionSnapshotsForRuns(
          db,
          [...latestRuns.values()].map((run) => run.id),
        );
        return Promise.all(
          rows.map(async (row) => {
            const meta = flowGraphMeta(await getLatestVersion(db, row.id));
            const latestRun = latestRuns.get(row.id) ?? null;
            const runMeta = latestRunMeta(latestRun, snapshots.get(latestRun?.id ?? ''));
            return toDbFlow(row, {
              ...meta,
              ...runMeta,
            });
          }),
        );
      }),

    listRuns: publicProcedureRaw
      .input(
        z.object({ flowId: z.string().min(1), limit: z.number().int().min(1).max(100).optional() }),
      )
      .query(async ({ input }) => {
        const db = getDatabase();
        const rows = await listFlowRunsForFlow(db, input.flowId, input.limit ?? 20);
        const activeByRun = await getActiveFlowDrivingStatusByRun(
          db,
          rows.map((run) => run.id),
        );
        const snapshots = flowRunAdmissionSnapshotsForRuns(
          db,
          rows.map((run) => run.id),
        );
        return rows.map((run) => {
          const snapshot = snapshots.get(run.id);
          return toDbFlowRun(
            { ...run, status: snapshot?.runStatus ?? run.status },
            activeByRun.get(run.id) ?? null,
            snapshot?.admission ?? null,
          );
        });
      }),
  };
}
