import { describe, expect, it } from 'vitest';
import type { Task as DbTask } from '../db/schema';
import { resolveFlowCodexSpeedForTask } from '../flows/rerun/claim-flags';

type TaskFixture = Pick<DbTask, 'flowRunId' | 'triggerContext' | 'source'>;

describe('resolveFlowCodexSpeedForTask', () => {
  it.each([
    [{ flowRunId: null, triggerContext: null, source: 'manual' }, undefined],
    [
      {
        flowRunId: 'flow-fast',
        triggerContext: { _config: { codexSpeed: 'ultrafast' } },
        source: 'flow',
      },
      'ultrafast',
    ],
    // `standard` must survive, not collapse to undefined: it is what actively clears a
    // chat's paid speed after an earlier run left it on.
    [
      {
        flowRunId: 'flow-standard',
        triggerContext: { _config: { codexSpeed: 'standard' } },
        source: 'flow',
      },
      'standard',
    ],
    // Cloud fire-and-forget carries the Flow's value with no flow_run_id link.
    [
      { flowRunId: null, triggerContext: { _config: { codexSpeed: 'ultrafast' } }, source: 'flow' },
      'ultrafast',
    ],
    // NO legacy-on default, unlike Auto: a flow-linked task carrying no value yields undefined so
    // the chat's own state is left alone. Defaulting to `true` would spend credits unasked.
    [{ flowRunId: 'flow-legacy', triggerContext: { _config: {} }, source: 'flow' }, undefined],
    [{ flowRunId: null, triggerContext: { _config: {} }, source: 'flow' }, undefined],
    // Provenance, not content, is the grant: `_config` is caller-supplied, so a non-flow task must
    // never be able to opt itself into a tier that bills 2-2.5x credits.
    [
      {
        flowRunId: null,
        triggerContext: { _config: { codexSpeed: 'ultrafast' } },
        source: 'manual',
      },
      undefined,
    ],
    // Unknown speed names are rejected rather than coerced.
    [
      {
        flowRunId: 'flow-bad',
        triggerContext: { _config: { codexSpeed: 'yes' } },
        source: 'flow',
      },
      undefined,
    ],
  ] as const)('returns %s for the task config', (task, expected) => {
    expect(resolveFlowCodexSpeedForTask(task as TaskFixture)).toBe(expected);
  });
});
