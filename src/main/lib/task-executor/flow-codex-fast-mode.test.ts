import { describe, expect, it } from 'vitest';
import type { Task as DbTask } from '../db/schema';
import { resolveFlowCodexFastModeForTask } from '../flows/rerun/claim-flags';

type TaskFixture = Pick<DbTask, 'flowRunId' | 'triggerContext' | 'source'>;

describe('resolveFlowCodexFastModeForTask', () => {
  it.each([
    [{ flowRunId: null, triggerContext: null, source: 'manual' }, undefined],
    [
      {
        flowRunId: 'flow-fast',
        triggerContext: { _config: { codexFastMode: true } },
        source: 'flow',
      },
      true,
    ],
    // `false` must survive as `false`, not collapse to undefined: it is what actively clears a
    // chat's Fast state after an earlier Fast run left it on.
    [
      {
        flowRunId: 'flow-standard',
        triggerContext: { _config: { codexFastMode: false } },
        source: 'flow',
      },
      false,
    ],
    // Cloud fire-and-forget carries the Flow's value with no flow_run_id link.
    [
      { flowRunId: null, triggerContext: { _config: { codexFastMode: true } }, source: 'flow' },
      true,
    ],
    // NO legacy-on default, unlike Auto: a flow-linked task carrying no value yields undefined so
    // the chat's own state is left alone. Defaulting to `true` would spend credits unasked.
    [{ flowRunId: 'flow-legacy', triggerContext: { _config: {} }, source: 'flow' }, undefined],
    [{ flowRunId: null, triggerContext: { _config: {} }, source: 'flow' }, undefined],
    // Provenance, not content, is the grant: `_config` is caller-supplied, so a non-flow task must
    // never be able to opt itself into a tier that bills 2-2.5x credits.
    [
      { flowRunId: null, triggerContext: { _config: { codexFastMode: true } }, source: 'manual' },
      undefined,
    ],
    // Non-boolean values are rejected rather than coerced.
    [
      {
        flowRunId: 'flow-bad',
        triggerContext: { _config: { codexFastMode: 'yes' } },
        source: 'flow',
      },
      undefined,
    ],
  ] as const)('returns %s for the task config', (task, expected) => {
    expect(resolveFlowCodexFastModeForTask(task as TaskFixture)).toBe(expected);
  });
});
