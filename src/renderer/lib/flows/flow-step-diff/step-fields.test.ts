import { describe, expect, it } from 'vitest';
import type { FlowNode } from '../../../../shared/lib/validate-flow-graph';
import { stepFieldChanges } from './step-fields';

function agent(config: FlowNode['config'], label = 'Ship PR'): FlowNode {
  return { id: 'ship', blockType: 'agent', label, config };
}

describe('stepFieldChanges', () => {
  it('shows display-safe settings as old and new values, with friendly model names', () => {
    const rows = stepFieldChanges(
      agent({ model: 'sonnet', fireAndForget: false, maxIterations: 3 }),
      agent({ model: 'opus', fireAndForget: true, maxIterations: 5 }, 'Ship the PR'),
    );

    expect(rows).toEqual([
      { kind: 'value', label: 'Step name', before: 'Ship PR', after: 'Ship the PR' },
      {
        kind: 'value',
        label: 'Model',
        before: expect.stringMatching(/Sonnet/),
        after: expect.stringMatching(/Opus/),
      },
      { kind: 'value', label: 'Completion behavior', before: 'Off', after: 'On' },
      { kind: 'value', label: 'Iteration limit', before: '3', after: '5' },
    ]);
  });

  it('never shows values for secret-prone or unreviewed keys, and merges unknown keys into one row', () => {
    const rows = stepFieldChanges(
      agent({ headers: { Authorization: 'Bearer old' }, apiKey: 'sk-old', token: 'a' }),
      agent({ headers: { Authorization: 'Bearer new' }, apiKey: 'sk-new', token: 'b' }),
    );

    expect(rows).toEqual([
      { kind: 'label', label: 'Request headers' },
      { kind: 'label', label: 'Other step setup' },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/Bearer|sk-/);
  });

  it('gives a command a word diff but no collapsed preview', () => {
    const [row] = stepFieldChanges(
      agent({ command: 'deploy --token abc' }),
      agent({ command: 'deploy --token xyz' }),
    );

    expect(row).toMatchObject({ kind: 'text', label: 'Command', showPreview: false });
  });

  it('shows one Instructions row when a slash command sets both instruction keys', () => {
    const rows = stepFieldChanges(
      agent({ instructions: 'Write the notes.' }),
      agent({ instructionsCommandName: 'ship', instructions: 'Run the ship command.' }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'text',
      label: 'Instructions',
      after: 'Run the ship command.',
    });
  });

  it('skips a shown value that only went from empty to removed, but keeps other keys', () => {
    expect(
      stepFieldChanges(agent({ branch: '', instructions: null, customKey: '' }), agent({})),
    ).toEqual([{ kind: 'label', label: 'Other step setup' }]);
  });

  it('returns nothing when only canvas position changed', () => {
    const before = { ...agent({ instructions: 'Same' }), position: { x: 0, y: 0 } };
    const after = { ...agent({ instructions: 'Same' }), position: { x: 40, y: 0 } };

    expect(stepFieldChanges(before, after)).toEqual([]);
  });
});
