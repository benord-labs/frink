import { describe, expect, it } from 'vitest';
import { assistantPartsStateFromChunks } from '../../../../../shared/lib/assistant-parts';
import type { UIMessageChunk } from '../../../claude/types';
import { compactionOpened, compactionSettled, createCompactionFailureSettler } from './index';

const opened = compactionOpened('cmp-1');
const settled = compactionSettled('cmp-1');
const error: UIMessageChunk = { type: 'error', errorText: 'context window exceeded' };

describe('a Codex compaction on the compact line', () => {
  it('opens a live-only chunk when the compaction starts', () => {
    expect(opened).toEqual([
      { type: 'data-compact', id: 'cmp-1', transient: true, data: { state: 'input-streaming' } },
    ]);
  });

  it('settles the same id as an automatic compaction when it completes', () => {
    expect(settled).toEqual([
      { type: 'data-compact', id: 'cmp-1', data: { state: 'output-available', trigger: 'auto' } },
    ]);
  });

  it('emits nothing for a compaction without an id', () => {
    expect(compactionOpened('')).toEqual([]);
    expect(compactionSettled('')).toEqual([]);
  });

  it('saves one transcript line for a compaction that ran to completion', () => {
    expect(assistantPartsStateFromChunks([...opened, ...settled]).parts).toEqual([
      { type: 'data-compact', id: 'cmp-1', data: { state: 'output-available', trigger: 'auto' } },
    ]);
  });

  it('saves a line for a compaction whose start was never seen', () => {
    expect(assistantPartsStateFromChunks(settled).parts).toHaveLength(1);
  });

  it('saves nothing for a compaction that only started', () => {
    expect(assistantPartsStateFromChunks(opened).parts).toEqual([]);
  });
});

describe('createCompactionFailureSettler', () => {
  it('settles an open compaction as failed ahead of the error that ended it', () => {
    const settle = createCompactionFailureSettler();
    settle(opened[0]);

    expect(settle(error)).toEqual([
      { type: 'data-compact', id: 'cmp-1', data: { state: 'output-error' } },
      error,
    ]);
  });

  it('reports the failure once', () => {
    const settle = createCompactionFailureSettler();
    settle(opened[0]);
    settle(error);

    expect(settle(error)).toEqual([error]);
  });

  it('leaves an error alone when no compaction is open', () => {
    expect(createCompactionFailureSettler()(error)).toEqual([error]);
  });

  it('leaves an error alone once the compaction completed', () => {
    const settle = createCompactionFailureSettler();
    settle(opened[0]);
    settle(settled[0]);

    expect(settle(error)).toEqual([error]);
  });

  it('reports a later compaction that fails after an earlier one in the turn settled', () => {
    const settle = createCompactionFailureSettler();
    settle(opened[0]);
    settle(settled[0]);
    settle(compactionOpened('cmp-2')[0]);

    expect(settle(error)).toEqual([
      { type: 'data-compact', id: 'cmp-2', data: { state: 'output-error' } },
      error,
    ]);
  });

  it('passes every other chunk through untouched while a compaction is open', () => {
    const settle = createCompactionFailureSettler();
    settle(opened[0]);
    const text: UIMessageChunk = { type: 'text-delta', id: 't1', delta: 'hi' };

    expect(settle(text)).toEqual([text]);
  });
});
