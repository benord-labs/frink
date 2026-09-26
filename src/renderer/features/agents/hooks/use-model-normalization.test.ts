// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CODEX_DEFAULT_MODEL_ID } from '../../../../shared/lib/codex-cli-models';
import { useModelNormalization } from './use-model-normalization';

describe('useModelNormalization', () => {
  it('resets a stale model ID to sonnet when switching to a Claude account', () => {
    const setModel = vi.fn();
    const { rerender } = renderHook(
      ({ isCodex, modelId }) => useModelNormalization(isCodex, modelId, setModel),
      { initialProps: { isCodex: true, modelId: CODEX_DEFAULT_MODEL_ID } },
    );
    act(() => {
      rerender({ isCodex: false, modelId: CODEX_DEFAULT_MODEL_ID });
    });
    expect(setModel).toHaveBeenCalledWith('sonnet');
  });

  it('does not reset a valid Claude model ID', () => {
    const setModel = vi.fn();
    const { rerender } = renderHook(
      ({ isCodex, modelId }) => useModelNormalization(isCodex, modelId, setModel),
      { initialProps: { isCodex: true, modelId: CODEX_DEFAULT_MODEL_ID } },
    );
    act(() => {
      rerender({ isCodex: false, modelId: 'opus' });
    });
    expect(setModel).not.toHaveBeenCalled();
  });

  it('normalizes an id from a retired provider on initial mount', () => {
    const setModel = vi.fn();
    renderHook(() => useModelNormalization(false, 'cursor-fake-removed-slug', setModel));
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith('sonnet');
  });

  it('does not re-normalize when only modelId changes (avoids split-view ping-pong on model updates)', () => {
    const setModel = vi.fn();
    const { rerender } = renderHook(
      ({ modelId }) => useModelNormalization(true, modelId, setModel),
      { initialProps: { modelId: CODEX_DEFAULT_MODEL_ID } },
    );
    setModel.mockClear();
    act(() => {
      rerender({ modelId: 'codex-gpt-5.4-high' });
    });
    expect(setModel).not.toHaveBeenCalled();
  });

  it('skips normalization when accountResolved is false (query still loading)', () => {
    const setModel = vi.fn();
    // A Codex model id with the account not yet resolved — must NOT clobber to sonnet.
    renderHook(() => useModelNormalization(false, CODEX_DEFAULT_MODEL_ID, setModel, false));
    expect(setModel).not.toHaveBeenCalled();
  });

  it('normalizes after accountResolved becomes true', () => {
    const setModel = vi.fn();
    const { rerender } = renderHook(
      ({ modelId, resolved }) => useModelNormalization(false, modelId, setModel, resolved),
      { initialProps: { modelId: CODEX_DEFAULT_MODEL_ID, resolved: false } },
    );
    expect(setModel).not.toHaveBeenCalled();
    act(() => {
      rerender({ modelId: CODEX_DEFAULT_MODEL_ID, resolved: true });
    });
    expect(setModel).toHaveBeenCalledWith('sonnet');
  });

  it('preserves a Codex model when the account resolves as Codex', () => {
    const setModel = vi.fn();
    const { rerender } = renderHook(
      ({ isCodex, modelId, resolved }) =>
        useModelNormalization(isCodex, modelId, setModel, resolved),
      { initialProps: { isCodex: false, modelId: CODEX_DEFAULT_MODEL_ID, resolved: false } },
    );
    expect(setModel).not.toHaveBeenCalled();
    act(() => {
      rerender({ isCodex: true, modelId: CODEX_DEFAULT_MODEL_ID, resolved: true });
    });
    expect(setModel).not.toHaveBeenCalled();
  });

  it('resets a stale model ID to the Codex default when switching to Codex account', () => {
    const setModel = vi.fn();
    const { rerender } = renderHook(
      ({ isCodex, modelId }) => useModelNormalization(isCodex, modelId, setModel),
      { initialProps: { isCodex: false, modelId: 'sonnet' } },
    );
    act(() => {
      rerender({ isCodex: true, modelId: 'sonnet' });
    });
    expect(setModel).toHaveBeenCalledWith(CODEX_DEFAULT_MODEL_ID);
  });

  it('multi-pane: a claude pane and a codex pane do not oscillate each other', () => {
    // Two hook instances with distinct per-pane setters + accounts: guards the split-view
    // ping-pong the hook warns about — each pane settles once and never retriggers the other.
    const setA = vi.fn();
    const setB = vi.fn();
    renderHook(({ id }) => useModelNormalization(false, id, setA), {
      initialProps: { id: 'sonnet' },
    }); // claude pane, already-valid claude id → no change
    const b = renderHook(({ id }) => useModelNormalization(true, id, setB), {
      initialProps: { id: CODEX_DEFAULT_MODEL_ID },
    }); // codex pane, already-valid codex id → no change
    expect(setA).not.toHaveBeenCalled();
    expect(setB).not.toHaveBeenCalled();

    // Change ONLY the codex pane's model — neither setter fires (modelId is read via ref, not in
    // the dep array, so a model change never retriggers normalization in either pane).
    act(() => {
      b.rerender({ id: 'codex-gpt-5.4-high' });
    });
    expect(setA).not.toHaveBeenCalled();
    expect(setB).not.toHaveBeenCalled();
  });
});
