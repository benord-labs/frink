import { describe, expect, it } from 'vitest';
import type { Task as DbTask } from '../db/schema';
import { resolveFlowAutoReviewToolsForTask } from '../flows/rerun/claim-flags';

type TaskFixture = Pick<DbTask, 'flowRunId' | 'triggerContext' | 'source'>;

describe('resolveFlowAutoReviewToolsForTask', () => {
  it.each([
    [{ flowRunId: null, triggerContext: null, source: 'manual' }, undefined],
    [{ flowRunId: 'flow-legacy', triggerContext: { _config: {} }, source: 'flow' }, true],
    [
      {
        flowRunId: 'flow-enabled',
        triggerContext: { _config: { autoReviewTools: true } },
        source: 'flow',
      },
      true,
    ],
    [
      {
        flowRunId: 'flow-disabled',
        triggerContext: { _config: { autoReviewTools: false } },
        source: 'flow',
      },
      false,
    ],
    // Cloud fire-and-forget: the Flow's value rides trigger_context with no flow_run_id link,
    // because linking the row would expose it to the flow-run recovery sweeps.
    [
      { flowRunId: null, triggerContext: { _config: { autoReviewTools: true } }, source: 'flow' },
      true,
    ],
    [
      { flowRunId: null, triggerContext: { _config: { autoReviewTools: false } }, source: 'flow' },
      false,
    ],
    // A fire-and-forget task carrying no value has none — `flow` provenance alone never implies on.
    [{ flowRunId: null, triggerContext: { _config: {} }, source: 'flow' }, undefined],
    // Provenance, not content, is the grant: `_config` is not key-allowlisted and reaches the row
    // from caller-supplied context, so a non-flow task can never award itself Auto.
    [
      { flowRunId: null, triggerContext: { _config: { autoReviewTools: true } }, source: 'manual' },
      undefined,
    ],
  ] as const)('returns %s for the task config', (task, expected) => {
    expect(resolveFlowAutoReviewToolsForTask(task as TaskFixture)).toBe(expected);
  });
});
