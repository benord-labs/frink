import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../shared/lib/validate-flow-graph';
import type { NodeOutput } from '../../../shared/types/flow';
import * as database from '../db';
import { createNodeRun } from '../db/repos/node-runs';
import { flowRuns } from '../db/schema';
import {
  seedActiveAdmission,
  seedCompletedNodeRun,
  seedFlowRun,
} from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { setFlowAdmissionLifecycleHooks } from './admission/activity';
import { _setFlowAdmissionControllerForTests } from './admission/runtime';
import { buildVariables } from './block-context';
import * as dispatch from './dispatch';
import type { DispatchContext } from './dispatch/types';
import { loadFanOutState, saveBodyMembers, saveFanOutState } from './fan-out-state';
import { findAbsentShellPlaceholder, renderTemplateForShell } from './template-utils';
import { readRunFence } from './transitions';

const getDatabase = vi.spyOn(database, 'getDatabase');
const dispatchNode = vi.spyOn(dispatch, 'dispatchNode');

const completedOutput: NodeOutput = {
  status: 'completed',
  outputs: {},
  artifacts: [],
  durationMs: 0,
};

beforeEach(() => {
  setFlowAdmissionLifecycleHooks({
    reconcile: vi.fn(async () => {}),
    requestRelease: vi.fn(async () => {}),
  });
});
afterEach(() => _setFlowAdmissionControllerForTests(null));

describe('Retry restores the previous output a step was first handed', () => {
  const completedWith = (outputs: NodeOutput['outputs']): NodeOutput => ({
    ...completedOutput,
    outputs,
  });

  /** Replays the run's terminal-resume target through the real engine, recording each dispatch. */
  async function replay(db: TestDb, flowRunId: string): Promise<DispatchContext[]> {
    const { resolveTerminalResumeTarget, dispatchTerminalResumeTarget } =
      await import('./admission/terminal-resume/dispatcher');
    const target = await resolveTerminalResumeTarget(db, flowRunId);
    await db.update(flowRuns).set({ status: 'running' }).where(eq(flowRuns.id, flowRunId));
    const fence = readRunFence(db, flowRunId);
    if (!target || !fence) throw new Error('expected a resumable target and a live fence');
    const seen: DispatchContext[] = [];
    dispatchNode.mockReset().mockImplementation(async (ctx: DispatchContext) => {
      seen.push(ctx);
      return { type: 'completed', output: completedWith({ stdout: `${ctx.node.id} ok` }) };
    });
    await dispatchTerminalResumeTarget(fence, target);
    return seen;
  }

  it("renders a re-run run_command with its predecessor's real value", async () => {
    const db = freshDb();
    getDatabase.mockReturnValue(db);
    const command = 'echo "{{previous.summary}}"';
    const graph: FlowGraph = {
      nodes: [
        { id: 'summarise', blockType: 'run_command' },
        { id: 'rc', blockType: 'run_command', config: { command } },
      ],
      edges: [{ id: 'e1', source: 'summarise', target: 'rc' }],
    };
    const { flowRunId } = await seedFlowRun(db, graph);
    seedActiveAdmission(db, flowRunId);
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'summarise',
      blockType: 'run_command',
      outputs: { summary: 'shipped the fix' },
    });
    await createNodeRun(db, {
      flowRunId,
      nodeId: 'rc',
      blockType: 'run_command',
      status: 'failed',
    });

    const [ctx] = await replay(db, flowRunId);

    // The same refusal check and renderer run_command applies to the context the engine built.
    const variables = buildVariables({
      triggerContext: ctx?.triggerContext,
      previousOutput: ctx?.previousOutput,
      loopContext: ctx?.loopContext,
    });
    expect(findAbsentShellPlaceholder(command, variables)).toBeUndefined();
    expect(renderTemplateForShell(command, variables)).toContain('shipped the fix');
  });

  describe('inside a Fan Out', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 'fan', blockType: 'fan_out' },
        { id: 'rc', blockType: 'run_command', parentId: 'fan' },
        { id: 'after', blockType: 'run_command' },
      ],
      edges: [
        { id: 'e1', source: 'fan', target: 'rc' },
        { id: 'e2', source: 'rc', target: 'after' },
      ],
    };
    const items = ['first', 'second'];

    async function seedFirstItemDone(db: TestDb) {
      const { flowRunId, flowId } = await seedFlowRun(db, graph);
      seedActiveAdmission(db, flowRunId);
      const fanRun = await seedCompletedNodeRun(db, {
        flowRunId,
        nodeId: 'fan',
        blockType: 'fan_out',
        outputs: {
          currentItem: 'first',
          currentIndex: 0,
          totalCount: 2,
          _fanOutState: 'iterating',
          arrayField: 'items',
        },
      });
      const lane = (laneIndex: number) => ({ laneIndex, parentFanOutNodeRunId: fanRun.id });
      await seedCompletedNodeRun(db, {
        flowRunId,
        nodeId: 'rc',
        blockType: 'run_command',
        outputs: { stdout: 'rc ok' },
        ...lane(0),
      });
      return { flowRunId, flowId, lane };
    }

    it("re-runs a body step with its own item's previous and loop context", async () => {
      const db = freshDb();
      getDatabase.mockReturnValue(db);
      const { flowRunId, flowId, lane } = await seedFirstItemDone(db);
      await saveFanOutState(flowId, flowRunId, 'fan', {
        items,
        currentIndex: 1,
        totalCount: 2,
        maxIterations: 50,
        completedOutputs: [{ rc: { stdout: 'rc ok' } }],
        arrayField: 'items',
        branches: [{ rootNodeId: 'rc', tailNodeId: 'rc', nodeIds: ['rc'] }],
      });
      await saveBodyMembers(flowId, flowRunId, ['rc'], 'fan');
      await createNodeRun(db, {
        flowRunId,
        nodeId: 'rc',
        blockType: 'run_command',
        status: 'failed',
        ...lane(1),
      });

      const [body, after] = await replay(db, flowRunId);

      expect(body?.previousOutput?.outputs).toMatchObject({
        currentItem: 'second',
        currentIndex: 1,
      });
      expect(body?.loopContext).toEqual({ currentItem: 'second', currentIndex: 1, totalCount: 2 });
      // The last item finishing tears the Fan Out down: the continuation gets the aggregate, no loop.
      expect(after?.node.id).toBe('after');
      expect(after?.previousOutput?.outputs).toMatchObject({ totalCount: 2 });
      expect(after?.loopContext).toBeUndefined();
      expect(await loadFanOutState(flowId, flowRunId, 'fan')).toBeNull();
    });

    it('re-runs the continuation after teardown with the rebuilt aggregate', async () => {
      const db = freshDb();
      getDatabase.mockReturnValue(db);
      const { flowRunId, lane } = await seedFirstItemDone(db);
      await seedCompletedNodeRun(db, {
        flowRunId,
        nodeId: 'rc',
        blockType: 'run_command',
        outputs: { stdout: 'second ok' },
        ...lane(1),
      });
      await createNodeRun(db, {
        flowRunId,
        nodeId: 'after',
        blockType: 'run_command',
        status: 'failed',
      });

      const [after] = await replay(db, flowRunId);

      expect(after?.previousOutput?.outputs).toEqual({
        results: [{ rc: { stdout: 'rc ok' } }, { rc: { stdout: 'second ok' } }],
        totalCount: 2,
        _fanOutState: 'completed',
      });
      expect(after?.loopContext).toBeUndefined();
    });
  });
});
