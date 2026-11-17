import { describe, expect, it } from 'vitest';
import { createGoalMapper, type GoalFrame } from './index';

// Wording copied from the bundled Claude CLI's `/goal` command and Stop-hook feedback.
const synthetic = (text: string, parent: string | null = null): GoalFrame => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { model: '<synthetic>', content: [{ type: 'text', text }] },
});
const feedback = (text: string): GoalFrame => ({
  type: 'user',
  isSynthetic: true,
  parent_tool_use_id: null,
  message: { content: [{ type: 'text', text: `Stop hook feedback:\n${text}` }] },
});

function run(frames: GoalFrame[]) {
  const map = createGoalMapper();
  return frames.flatMap((frame) => map(frame));
}

const lastData = (frames: GoalFrame[]) => run(frames).at(-1);

describe('createGoalMapper', () => {
  it('opens a goal from the command reply', () => {
    expect(lastData([synthetic('Goal set: all tests pass')])).toMatchObject({
      type: 'data-goal',
      data: { state: 'active', objective: 'all tests pass' },
    });
  });

  it('records each failed check on the running goal under one part', () => {
    const chunks = run([
      synthetic('Goal set: all tests pass'),
      feedback('[all tests pass]: 3 tests still fail'),
    ]);
    expect(new Set(chunks.map((chunk) => 'id' in chunk && chunk.id)).size).toBe(1);
    expect(chunks.at(-1)).toMatchObject({
      data: { state: 'active', objective: 'all tests pass', lastCheck: '3 tests still fail' },
    });
  });

  it("ignores another Stop hook's feedback while a goal runs", () => {
    expect(
      run([synthetic('Goal set: all tests pass'), feedback('[bun run lint]: 2 errors')]),
    ).toHaveLength(1);
  });

  it('marks a check whose goal was set in an earlier turn', () => {
    expect(lastData([feedback('[all tests pass]: 1 test fails')])).toMatchObject({
      data: { state: 'checked', objective: 'all tests pass', lastCheck: '1 test fails' },
    });
  });

  it("keeps each checked objective in its own part, so another hook cannot replace the goal's", () => {
    const ids = run([
      feedback('[all tests pass]: 1 test fails'),
      feedback('[bun run lint]: 2 errors'),
      feedback('[all tests pass]: still 1'),
    ]).map((chunk) => ('id' in chunk ? chunk.id : ''));
    expect(ids[2]).toBe(ids[0]);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it.each([
    ['Goal active: ship it (not yet evaluated)', { objective: 'ship it' }],
    [
      'Goal active: ship (v2) (2 turns)\nLast check: docs missing',
      { objective: 'ship (v2)', lastCheck: 'docs missing' },
    ],
  ])('reads the status reply %j', (text, expected) => {
    expect(lastData([synthetic(text)])).toMatchObject({ data: { state: 'active', ...expected } });
  });

  it.each(['Goal cleared: ship it', 'No goal set. Usage: `/goal <condition>`'])(
    'clears on %j',
    (text) => {
      expect(lastData([synthetic(text)])).toMatchObject({ data: { state: 'cleared' } });
    },
  );

  it.each<[string, GoalFrame]>([
    [
      'model-written text',
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Goal set: x' }] },
      },
    ],
    ['a subagent reply', synthetic('Goal set: x', 'toolu_1')],
    ['an unrecognised reply', synthetic('Goal condition is limited to 4000 characters')],
    [
      'non-synthetic feedback text',
      {
        type: 'user',
        parent_tool_use_id: null,
        message: { content: 'Stop hook feedback:\n[x]: y' },
      },
    ],
    ['an unrelated frame', { type: 'system' }],
  ])('changes nothing for %s', (_label, frame) => {
    expect(run([frame])).toEqual([]);
  });
});

describe('createGoalMapper stops', () => {
  const result: GoalFrame = { type: 'result' };

  it("marks every result with whether that stop's background work deferred the check", () => {
    let defers = true;
    const map = createGoalMapper(() => defers);
    const first = map(result);
    defers = false;
    // A harness result (task notification) and Frink's own result can share one transformer.
    const second = map(result);
    expect(first).toMatchObject([
      { type: 'data-goal', data: { state: 'stopped', deferred: true } },
    ]);
    expect(second).toMatchObject([{ data: { state: 'stopped', deferred: false } }]);
    expect('id' in first[0] && first[0].id).not.toBe('id' in second[0] && second[0].id);
  });

  it('marks a result as evaluated when no Stop hook reported background work', () => {
    expect(run([result])).toMatchObject([{ data: { state: 'stopped', deferred: false } }]);
  });
});
