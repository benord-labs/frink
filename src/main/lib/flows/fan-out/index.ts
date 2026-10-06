/** The outputs a Fan Out hands its body and continuation; the engine and the retry rebuild share them. */

import { z } from 'zod';
import type { FanOutBranch } from '../../../../shared/lib/compute-fan-out-body-chain';
import type { NodeOutput } from '../../../../shared/types/flow';
import type { FanOutIterationState } from '../fan-out-state';

export type FanOutItemSource = Pick<
  FanOutIterationState,
  'items' | 'totalCount' | 'arrayField' | 'truncated' | 'originalCount'
>;

const nodeRunOutputSchema = z.object({
  outputs: z.record(z.string(), z.unknown()),
});

/** previousOutput for every body root of item `index`; item 0 matches the fan_out's own output. */
export function iterationOutput(state: FanOutItemSource, index: number): NodeOutput {
  const outputs: NodeOutput['outputs'] = {
    currentItem: state.items[index],
    currentIndex: index,
    totalCount: state.totalCount,
    _fanOutState: 'iterating',
    arrayField: state.arrayField,
  };
  if (state.truncated) {
    outputs.truncated = true;
    outputs.originalCount = state.originalCount;
  }
  return {
    status: 'completed',
    outputs,
    artifacts: [],
    durationMs: 0,
  };
}

function nodeRunOutputs<T>(value: T): NodeOutput['outputs'] {
  const parsed = nodeRunOutputSchema.safeParse(value);
  return parsed.success ? parsed.data.outputs : {};
}

/** One item's aggregate entry: each branch's tail outputs, keyed by the branch root. */
export function laneItemOutputs(
  branches: FanOutBranch[],
  completedTails: Array<{ nodeId: string; nodeOutput: unknown }>,
): NodeOutput['outputs'] {
  return Object.fromEntries(
    branches.map((branch) => {
      const tail = completedTails.findLast((nodeRun) => nodeRun.nodeId === branch.tailNodeId);
      return [branch.rootNodeId, nodeRunOutputs(tail?.nodeOutput)];
    }),
  );
}

/** previousOutput for the continuation once every item has finished. */
export function fanOutCompletedOutput(aggregateOutputs: Array<NodeOutput['outputs']>): NodeOutput {
  return {
    status: 'completed',
    outputs: {
      results: aggregateOutputs,
      totalCount: aggregateOutputs.length,
      _fanOutState: 'completed',
    },
    artifacts: [],
    durationMs: 0,
  };
}
