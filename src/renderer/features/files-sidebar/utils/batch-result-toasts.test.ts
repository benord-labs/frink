import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  undoFileMove: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@sentry/electron/renderer', () => ({ captureException: mocks.captureException }));

vi.mock('sonner', () => ({
  toast: { success: mocks.success, error: mocks.error, warning: mocks.warning },
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: { files: { undoFileMove: { mutate: mocks.undoFileMove } } },
}));

const {
  showBatchResultToast,
  buildBatchMoveUndo,
  showMoveToast,
  showTrashToast,
  reportUndoOutcome,
  UNDO_TOAST_DURATION_MS,
} = await import('./batch-result-toasts');

const PROJECT = '/tmp/project';

describe('showBatchResultToast', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
  });

  it('offers Undo on success when an undo callback is supplied', () => {
    const undo = vi.fn().mockResolvedValue(undefined);
    showBatchResultToast('Moved', [{ success: true }], undo);

    const [message, options] = mocks.success.mock.calls[0];
    expect(message).toBe('Moved 1 item');
    expect(options.duration).toBe(UNDO_TOAST_DURATION_MS);
    options.action.onClick();
    expect(undo).toHaveBeenCalledOnce();
  });

  it('shows no action when no undo callback is supplied', () => {
    showBatchResultToast('Moved', [{ success: true }]);

    expect(mocks.success).toHaveBeenCalledWith('Moved 1 item', undefined);
  });

  it('never offers Undo when every item failed', () => {
    showBatchResultToast('Moved', [{ success: false }], vi.fn());

    expect(mocks.error).toHaveBeenCalledWith('Failed to move 1 item');
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('still offers Undo on a partial batch, for the items that did move', () => {
    const undo = vi.fn().mockResolvedValue(undefined);
    showBatchResultToast('Moved', [{ success: true }, { success: false }], undo);

    const [message, options] = mocks.warning.mock.calls[0];
    expect(message).toBe('Moved 1 item, 1 failed');
    expect(options.duration).toBe(UNDO_TOAST_DURATION_MS);
    options.action.onClick();
    expect(undo).toHaveBeenCalledOnce();
  });

  it('shows nothing at all for an empty result set', () => {
    showBatchResultToast('Moved', [], vi.fn());

    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('uses trash wording for trashed items', () => {
    showBatchResultToast('Trashed', [{ success: true }]);
    showBatchResultToast('Trashed', [{ success: false }]);

    expect(mocks.success).toHaveBeenCalledWith('Trashed 1 item', undefined);
    expect(mocks.error).toHaveBeenCalledWith('Failed to trash 1 item');
  });
});

describe('call-site wrappers', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.undoFileMove.mockResolvedValue({ success: true });
  });

  it('showTrashToast reports a trash with no Undo, since trashing is not reversible in-app', () => {
    showTrashToast([{ success: true }]);

    expect(mocks.success).toHaveBeenCalledWith('Trashed 1 item', undefined);
  });

  it('showMoveToast wires a working Undo into the move toast', async () => {
    const onUndone = vi.fn();
    showMoveToast(
      PROJECT,
      [{ sourcePath: 'a/x.txt', destPath: 'd/x.txt', success: true }],
      onUndone,
    );

    const [, options] = mocks.success.mock.calls[0];
    // The toast action deliberately voids the promise (sonner is fire-and-forget),
    // so the undo has to be awaited by observing its effect.
    options.action.onClick();

    await vi.waitFor(() => expect(onUndone).toHaveBeenCalledOnce());
    expect(mocks.undoFileMove).toHaveBeenCalledOnce();
  });

  it('reportUndoOutcome distinguishes full, partial and total failure', () => {
    const ok = { status: 'fulfilled', value: undefined } as const;
    const bad = { status: 'rejected', reason: new Error('nope') } as const;

    reportUndoOutcome([ok, ok], 2);
    reportUndoOutcome([ok, bad], 2);
    reportUndoOutcome([bad, bad], 2);

    expect(mocks.success).toHaveBeenCalledWith('Undid 2 moves');
    expect(mocks.warning).toHaveBeenCalledWith('Undid 1 of 2 moves');
    expect(mocks.error).toHaveBeenCalledWith('Undo failed');
  });

  it('reportUndoOutcome captures every rejection, since the user only sees a smaller count', () => {
    const reason = new Error('original location now contains a different file');
    reportUndoOutcome(
      [
        { status: 'fulfilled', value: undefined },
        { status: 'rejected', reason },
      ],
      2,
    );

    expect(mocks.captureException).toHaveBeenCalledExactlyOnceWith(reason, {
      tags: { area: 'files-undo-move' },
    });
  });
});

describe('buildBatchMoveUndo', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.undoFileMove.mockResolvedValue({ success: true });
  });

  it('returns undefined when nothing moved, so no Undo button is offered', () => {
    const undo = buildBatchMoveUndo({
      projectPath: PROJECT,
      results: [{ sourcePath: 'a.txt', success: false }],
      onUndone: vi.fn(),
    });

    expect(undo).toBeUndefined();
  });

  it('skips successful no-ops that never actually moved', () => {
    const undo = buildBatchMoveUndo({
      projectPath: PROJECT,
      // success but no destPath = source was already in the destination
      results: [{ sourcePath: 'dst/a.txt', success: true }],
      onUndone: vi.fn(),
    });

    expect(undo).toBeUndefined();
  });

  it('reverses each moved item back to its own original folder', async () => {
    const onUndone = vi.fn();
    const undo = buildBatchMoveUndo({
      projectPath: PROJECT,
      results: [
        { sourcePath: 'one/a.txt', destPath: 'dst/a.txt', success: true },
        { sourcePath: 'two/b.txt', destPath: 'dst/b.txt', success: true },
      ],
      onUndone,
    });

    await undo?.();

    expect(mocks.undoFileMove).toHaveBeenCalledTimes(2);
    expect(mocks.undoFileMove).toHaveBeenCalledWith({
      sourceProjectPath: PROJECT,
      sourcePath: 'one/a.txt',
      destProjectPath: PROJECT,
      destPath: 'dst/a.txt',
    });
    expect(onUndone).toHaveBeenCalledOnce();
    expect(mocks.success).toHaveBeenCalledWith('Undid 2 moves');
  });

  it('restores what it can and reports the shortfall when one item fails', async () => {
    mocks.undoFileMove
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('original location now contains a different file'));

    const onUndone = vi.fn();
    const undo = buildBatchMoveUndo({
      projectPath: PROJECT,
      results: [
        { sourcePath: 'one/a.txt', destPath: 'dst/a.txt', success: true },
        { sourcePath: 'two/b.txt', destPath: 'dst/b.txt', success: true },
      ],
      onUndone,
    });

    await undo?.();

    expect(mocks.warning).toHaveBeenCalledWith('Undid 1 of 2 moves');
    // The tree still refreshes — one item did move back.
    expect(onUndone).toHaveBeenCalledOnce();
  });

  it('returns undefined for an empty result set', () => {
    expect(
      buildBatchMoveUndo({ projectPath: PROJECT, results: [], onUndone: vi.fn() }),
    ).toBeUndefined();
  });

  it('reverses only the real moves in a mixed batch', async () => {
    const undo = buildBatchMoveUndo({
      projectPath: PROJECT,
      results: [
        { sourcePath: 'one/a.txt', destPath: 'dst/a.txt', success: true },
        { sourcePath: 'dst/b.txt', success: true }, // no-op, already in destination
        { sourcePath: 'two/c.txt', success: false }, // collided, never moved
      ],
      onUndone: vi.fn(),
    });

    await undo?.();

    expect(mocks.undoFileMove).toHaveBeenCalledExactlyOnceWith({
      sourceProjectPath: PROJECT,
      sourcePath: 'one/a.txt',
      destProjectPath: PROJECT,
      destPath: 'dst/a.txt',
    });
    expect(mocks.success).toHaveBeenCalledWith('Undid 1 move');
  });

  it('is safe to invoke twice — the second pass reports failure, it does not move anything else', async () => {
    mocks.undoFileMove
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('Cannot undo: file no longer exists at destination'));

    const undo = buildBatchMoveUndo({
      projectPath: PROJECT,
      results: [{ sourcePath: 'one/a.txt', destPath: 'dst/a.txt', success: true }],
      onUndone: vi.fn(),
    });

    await undo?.();
    await undo?.();

    // Double-clicking Undo is harmless: the backend's still-at-destination
    // guard turns the repeat into a refusal rather than a second move.
    expect(mocks.success).toHaveBeenCalledWith('Undid 1 move');
    expect(mocks.error).toHaveBeenCalledWith('Undo failed');
  });

  it('reports a total failure when no item can be reversed', async () => {
    mocks.undoFileMove.mockRejectedValue(new Error('nope'));

    const undo = buildBatchMoveUndo({
      projectPath: PROJECT,
      results: [{ sourcePath: 'one/a.txt', destPath: 'dst/a.txt', success: true }],
      onUndone: vi.fn(),
    });

    await undo?.();

    expect(mocks.error).toHaveBeenCalledWith('Undo failed');
  });
});
