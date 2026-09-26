import { describe, expect, it, vi } from 'vitest';
import { killTerminalPanesByIds } from './kill-terminal-panes';
import type { TerminalInstance } from './types';

function term(id: string, paneId = `p-${id}`): TerminalInstance {
  return { id, paneId, name: id, createdAt: 0 };
}

describe('killTerminalPanesByIds', () => {
  it('collects successes after an individual kill throws (partial success)', async () => {
    const terminals = [term('a'), term('b'), term('c')];
    const mutateAsync = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('pty busy'))
      .mockResolvedValueOnce(undefined);

    const result = await killTerminalPanesByIds(mutateAsync, terminals, ['a', 'b', 'c']);

    expect(result.succeededIds).toEqual(['a', 'c']);
    expect(result.errors).toEqual(['pty busy']);
    expect(mutateAsync).toHaveBeenCalledTimes(3);
  });

  it('records one error per failed kill when multiple fail', async () => {
    const terminals = [term('x'), term('y')];
    const mutateAsync = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'));

    const result = await killTerminalPanesByIds(mutateAsync, terminals, ['x', 'y']);

    expect(result.succeededIds).toEqual([]);
    expect(result.errors).toEqual(['first', 'second']);
  });

  it('stringifies non-Error rejections', async () => {
    const terminals = [term('a')];
    const mutateAsync = vi.fn().mockRejectedValueOnce('boom');

    const result = await killTerminalPanesByIds(mutateAsync, terminals, ['a']);

    expect(result.errors).toEqual(['boom']);
  });

  it('skips ids with no matching terminal without throwing or counting as success', async () => {
    const terminals = [term('a')];
    const mutateAsync = vi.fn().mockResolvedValue(undefined);

    const result = await killTerminalPanesByIds(mutateAsync, terminals, ['missing', 'a']);

    expect(result.succeededIds).toEqual(['a']);
    expect(result.errors).toEqual([]);
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({ paneId: 'p-a' });
  });

  it('uses the last terminal for an id when the terminals list contains duplicate ids', async () => {
    const terminals = [
      { id: 'dup', paneId: 'p-first', name: 'first', createdAt: 0 },
      { id: 'dup', paneId: 'p-second', name: 'second', createdAt: 1 },
    ];
    const mutateAsync = vi.fn().mockResolvedValue(undefined);

    await killTerminalPanesByIds(mutateAsync, terminals, ['dup']);

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({ paneId: 'p-second' });
  });
});
