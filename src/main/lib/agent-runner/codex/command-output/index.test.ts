import { describe, expect, it } from 'vitest';
import { type CodexCommandOutputs, recordCodexCommandOutput } from '.';

const command = (id: string) => ({ item: { id, type: 'commandExecution' }, startedAtMs: 1000 });
const delta = (itemId: string, text: string) => ({ itemId, delta: text });

describe('recordCodexCommandOutput', () => {
  it('collects a command’s output from its start until it completes', () => {
    const outputs: CodexCommandOutputs = new Map();

    recordCodexCommandOutput(outputs, 'item/started', command('c1'));
    recordCodexCommandOutput(outputs, 'item/commandExecution/outputDelta', delta('c1', 'tick 1\n'));
    recordCodexCommandOutput(outputs, 'item/commandExecution/outputDelta', delta('c1', 'tick 2\n'));

    expect(outputs.get('c1')).toEqual({ startedAt: 1000, text: 'tick 1\ntick 2\n', cut: false });

    recordCodexCommandOutput(outputs, 'item/completed', command('c1'));

    expect(outputs.has('c1')).toBe(false);
  });

  it('keeps only a bounded tail of a chatty command', () => {
    const outputs: CodexCommandOutputs = new Map();
    recordCodexCommandOutput(outputs, 'item/started', command('c1'));

    for (let i = 0; i < 5000; i += 1) {
      recordCodexCommandOutput(outputs, 'item/commandExecution/outputDelta', delta('c1', `line ${i}\n`));
    }

    const output = outputs.get('c1');
    expect(output?.text.length).toBe(8192);
    expect(output?.text.endsWith('line 4999\n')).toBe(true);
    expect(output?.cut).toBe(true);
  });

  it('keeps only the tail of a single oversized chunk', () => {
    const outputs: CodexCommandOutputs = new Map();
    recordCodexCommandOutput(outputs, 'item/started', command('c1'));

    recordCodexCommandOutput(outputs, 'item/commandExecution/outputDelta', delta('c1', `${'a'.repeat(9000)}end`));

    expect(outputs.get('c1')?.text).toBe(`${'a'.repeat(8189)}end`);
    expect(outputs.get('c1')?.cut).toBe(true);
  });

  it('falls back to now for a start time that is missing or not a real time', () => {
    const outputs: CodexCommandOutputs = new Map();
    const before = Date.now();

    for (const [id, startedAtMs] of [['c0', 0], ['c1', -5], ['c2', Number.NaN], ['c3', undefined]] as const) {
      recordCodexCommandOutput(outputs, 'item/started', { item: { id, type: 'commandExecution' }, startedAtMs });
    }

    for (const output of outputs.values()) expect(output.startedAt).toBeGreaterThanOrEqual(before);
    expect(outputs.size).toBe(4);
  });

  it('ignores items that are not commands, and output for a command it never saw start', () => {
    const outputs: CodexCommandOutputs = new Map();

    recordCodexCommandOutput(outputs, 'item/started', { item: { id: 'm1', type: 'agentMessage' } });
    recordCodexCommandOutput(outputs, 'item/commandExecution/outputDelta', delta('c9', 'stray'));

    expect(outputs.size).toBe(0);
  });
});
