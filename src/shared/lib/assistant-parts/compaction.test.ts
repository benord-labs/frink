import { describe, expect, it } from 'vitest';
import { assistantPartsStateFromChunks } from './index';

type Chunk = {
  type: string;
  id?: string;
  delta?: string;
  transient?: boolean;
  data?: { state: string; trigger?: string };
};

const partsFor = (chunks: Chunk[]) => assistantPartsStateFromChunks(chunks).parts;

const open: Chunk = {
  type: 'data-compact',
  id: 'c1',
  transient: true,
  data: { state: 'input-streaming' },
};
const settle: Chunk = {
  type: 'data-compact',
  id: 'c1',
  data: { state: 'output-available', trigger: 'manual' },
};

describe('compaction survives into the persisted parts', () => {
  it('folds the lifecycle into one part so a reloaded transcript still shows it', () => {
    const parts = partsFor([
      { type: 'text-start' },
      { type: 'text-delta', delta: 'before' },
      { type: 'text-end' },
      open,
      settle,
    ]);

    expect(parts.filter((part) => part.type === 'data-compact')).toEqual([
      { type: 'data-compact', id: 'c1', data: { state: 'output-available', trigger: 'manual' } },
    ]);
  });

  it('keeps separate compactions apart by id', () => {
    const parts = partsFor([
      open,
      settle,
      { type: 'data-compact', id: 'c2', data: { state: 'output-error' } },
    ]);

    expect(parts.filter((part) => part.type === 'data-compact').map((part) => part.id)).toEqual([
      'c1',
      'c2',
    ]);
  });

  it('saves nothing for a compaction that never settled', () => {
    expect(partsFor([open])).toEqual([]);
  });

  it('does not split the surrounding prose', () => {
    const parts = partsFor([
      { type: 'text-start' },
      { type: 'text-delta', delta: 'one' },
      { type: 'text-end' },
      settle,
      { type: 'text-start' },
      { type: 'text-delta', delta: 'two' },
      { type: 'text-end' },
    ]);

    expect(parts.map((part) => part.type)).toEqual(['text', 'data-compact', 'text']);
  });
});
