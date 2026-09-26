import { getDatabase } from '../../db';
import { getFlowRun } from '../../db/repos/flow-runs';
import { getVersion } from '../../db/repos/flow-versions';
import { type FanOutIterationState, saveBodyMembers, saveFanOutState } from '../fan-out-state';
import { resolveFanOutStructure } from '../graph';
import type { Dispatcher } from './types';

const MAX_ITERATIONS_CAP = 50;

type FanOutConfig = {
  arrayField?: string;
  maxIterations?: number;
  mode?: 'sequential' | 'parallel';
};

export const dispatchFanOut: Dispatcher = async (ctx) => {
  const config = (ctx.node.config ?? {}) as FanOutConfig;
  const arrayField =
    typeof config.arrayField === 'string' && config.arrayField.trim().length > 0
      ? config.arrayField.trim()
      : 'items';
  const flooredMax =
    typeof config.maxIterations === 'number' && Number.isFinite(config.maxIterations)
      ? Math.floor(config.maxIterations)
      : Number.NaN;
  const maxIterations =
    Number.isFinite(flooredMax) && flooredMax > 0
      ? Math.min(flooredMax, MAX_ITERATIONS_CAP)
      : MAX_ITERATIONS_CAP;
  const mode = config.mode === 'parallel' ? 'parallel' : 'sequential';
  // Parallel lane dispatch is not implemented; without an explicit reject the
  // engine treats `parallel_pending` as a normal completed result and walks
  // the contained branches once with no loopContext (silent broken iteration).
  if (mode === 'parallel') {
    return {
      type: 'error',
      message:
        'fan_out: parallel mode is not yet implemented. Use mode: "sequential" until parallel lane dispatch lands.',
    };
  }

  const rawValue = ctx.previousOutput?.outputs?.[arrayField];
  if (rawValue === undefined) {
    return {
      type: 'error',
      message: `fan_out: field "${arrayField}" not found in previous output`,
    };
  }
  if (!Array.isArray(rawValue)) {
    return {
      type: 'error',
      message: `fan_out: field "${arrayField}" must be an array, got ${typeof rawValue}`,
    };
  }

  const originalCount = rawValue.length;
  const items = rawValue.slice(0, maxIterations);
  const totalCount = items.length;
  const truncated = originalCount > maxIterations;
  const structure = resolveFanOutStructure(
    ctx.parsedGraph.nodes,
    ctx.parsedGraph.edges,
    ctx.node.id,
  );
  if (!structure.ok) return { type: 'error', message: `fan_out: ${structure.message}` };

  if (totalCount === 0) {
    return {
      type: 'completed',
      output: {
        status: 'completed',
        outputs: { results: [], totalCount: 0, _fanOutState: 'completed', arrayField },
        artifacts: [],
        durationMs: 0,
      },
    };
  }

  const db = getDatabase();
  const run = await getFlowRun(db, ctx.flowRunId);
  if (!run) return { type: 'error', message: 'fan_out: flow run not found' };
  const version = await getVersion(db, run.flowVersionId);
  if (!version) return { type: 'error', message: 'fan_out: flow version not found' };
  const flowId = version.flowId;

  const { branches, bodyNodeIds } = structure.structure;

  const state: FanOutIterationState = {
    items,
    currentIndex: 0,
    totalCount,
    maxIterations,
    completedOutputs: [],
    arrayField,
    branches,
    ...(truncated ? { truncated: true, originalCount } : {}),
  };
  await saveFanOutState(flowId, ctx.flowRunId, ctx.node.id, state);
  await saveBodyMembers(flowId, ctx.flowRunId, bodyNodeIds, ctx.node.id);

  return {
    type: 'completed',
    output: {
      status: 'completed',
      outputs: {
        currentItem: items[0],
        currentIndex: 0,
        totalCount,
        _fanOutState: 'iterating',
        arrayField,
        ...(truncated ? { truncated: true, originalCount } : {}),
      },
      artifacts: [],
      durationMs: 0,
    },
  };
};
