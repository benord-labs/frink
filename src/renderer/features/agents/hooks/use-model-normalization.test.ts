// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CODEX_DEFAULT_MODEL_ID,
  type CodexAccountCatalog,
} from '../../../../shared/lib/codex-cli-models';
import { useModelNormalization } from './use-model-normalization';

describe('useModelNormalization', () => {
  it('resets a stale model ID to sonnet when switching to a Claude account', () => {
    const setModel = vi.fn();
    const { rerender } = renderHook(
      ({ provider, modelId }) => useModelNormalization(provider, modelId, setModel),
      { initialProps: { provider: 'codex', modelId: CODEX_DEFAULT_MODEL_ID } },
    );
    act(() => {
      rerender({ provider: 'claude-code', modelId: CODEX_DEFAULT_MODEL_ID });
    });
    expect(setModel).toHaveBeenCalledWith('sonnet');
  });

  it('does not reset a valid Claude model ID', () => {
    const setModel = vi.fn();
    const { rerender } = renderHook(
      ({ provider, modelId }) => useModelNormalization(provider, modelId, setModel),
      { initialProps: { provider: 'codex', modelId: CODEX_DEFAULT_MODEL_ID } },
    );
    act(() => {
      rerender({ provider: 'claude-code', modelId: 'opus' });
    });
    expect(setModel).not.toHaveBeenCalled();
  });

  it('normalizes an id from a retired provider on initial mount', () => {
    const setModel = vi.fn();
    renderHook(() => useModelNormalization('claude-code', 'cursor-fake-removed-slug', setModel));
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith('sonnet');
  });

  it('does not re-normalize when only modelId changes (avoids split-view ping-pong on model updates)', () => {
    const setModel = vi.fn();
    const { rerender } = renderHook(
      ({ modelId }) => useModelNormalization('codex', modelId, setModel),
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
    renderHook(() => useModelNormalization('claude-code', CODEX_DEFAULT_MODEL_ID, setModel, false));
    expect(setModel).not.toHaveBeenCalled();
  });

  it('normalizes after accountResolved becomes true', () => {
    const setModel = vi.fn();
    const { rerender } = renderHook(
      ({ modelId, resolved }) => useModelNormalization('claude-code', modelId, setModel, resolved),
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
      ({ provider, modelId, resolved }) =>
        useModelNormalization(provider, modelId, setModel, resolved),
      {
        initialProps: { provider: 'claude-code', modelId: CODEX_DEFAULT_MODEL_ID, resolved: false },
      },
    );
    expect(setModel).not.toHaveBeenCalled();
    act(() => {
      rerender({ provider: 'codex', modelId: CODEX_DEFAULT_MODEL_ID, resolved: true });
    });
    expect(setModel).not.toHaveBeenCalled();
  });

  it('resets a stale model ID to the Codex default when switching to Codex account', () => {
    const setModel = vi.fn();
    // A paid catalog that lists GPT-6 Astra as its default.
    const paid: CodexAccountCatalog = { tiers: { 'gpt-6-astra': [] }, defaultSlug: 'gpt-6-astra' };
    const { rerender } = renderHook(
      ({ provider, modelId }) => useModelNormalization(provider, modelId, setModel, true, paid),
      { initialProps: { provider: 'claude-code', modelId: 'sonnet' } },
    );
    act(() => {
      rerender({ provider: 'codex', modelId: 'sonnet' });
    });
    expect(setModel).toHaveBeenCalledWith(CODEX_DEFAULT_MODEL_ID);
  });

  it('multi-pane: a claude pane and a codex pane do not oscillate each other', () => {
    // Two hook instances with distinct per-pane setters + accounts: guards the split-view
    // ping-pong the hook warns about — each pane settles once and never retriggers the other.
    const setA = vi.fn();
    const setB = vi.fn();
    renderHook(({ id }) => useModelNormalization('claude-code', id, setA), {
      initialProps: { id: 'sonnet' },
    }); // claude pane, already-valid claude id → no change
    const b = renderHook(({ id }) => useModelNormalization('codex', id, setB), {
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

  describe('with a free account catalog (no GPT-6 Astra)', () => {
    const free: CodexAccountCatalog = {
      tiers: { 'gpt-6-luna': [], 'gpt-5.5': [] },
      defaultSlug: 'gpt-6-luna',
    };
    /** `undefined` while the catalog loads, `null` once it is known to be unavailable. */
    type CatalogProps = { catalog: CodexAccountCatalog | null | undefined };

    it("keeps a saved model the account can't use, so the chat can say so", () => {
      const setModel = vi.fn();
      renderHook(() =>
        useModelNormalization('codex', CODEX_DEFAULT_MODEL_ID, setModel, true, free),
      );
      expect(setModel).not.toHaveBeenCalled();
    });

    it("never rewrites a saved model when the account's catalog arrives later", () => {
      const setModel = vi.fn();
      const { rerender } = renderHook<void, CatalogProps>(
        ({ catalog }) =>
          useModelNormalization('codex', CODEX_DEFAULT_MODEL_ID, setModel, true, catalog),
        { initialProps: { catalog: null } },
      );
      act(() => {
        rerender({ catalog: free });
      });
      expect(setModel).not.toHaveBeenCalled();
    });

    it("waits for the account's catalog before choosing a default, never saving one it can't use", () => {
      // The catalog query only starts once the account resolves as Codex, so it is still loading
      // on the render that first sees the switch.
      const setModel = vi.fn();
      const { rerender } = renderHook<void, CatalogProps>(
        ({ catalog }) => useModelNormalization('codex', 'sonnet', setModel, true, catalog),
        { initialProps: { catalog: undefined } },
      );
      act(() => {
        rerender({ catalog: free });
      });
      expect(setModel).not.toHaveBeenCalledWith(CODEX_DEFAULT_MODEL_ID);
      expect(setModel).toHaveBeenCalledExactlyOnceWith('codex-gpt-6-luna-medium');
    });

    it('still moves a Claude id to a Codex model when the account list could not be read', () => {
      const setModel = vi.fn();
      renderHook(() => useModelNormalization('codex', 'sonnet', setModel, true, null));
      expect(setModel).toHaveBeenCalledExactlyOnceWith(CODEX_DEFAULT_MODEL_ID);
    });

    it("moves a Claude id to the account's default on a switch to Codex", () => {
      const setModel = vi.fn();
      renderHook(() => useModelNormalization('codex', 'sonnet', setModel, true, free));
      expect(setModel).toHaveBeenCalledWith('codex-gpt-6-luna-medium');
    });
  });

  it.each([
    ['claude-code', 'sonnet'],
    ['codex', CODEX_DEFAULT_MODEL_ID],
    ['opencode', 'anthropic/claude-sonnet-4-5'],
  ])('on %s, an agent-qualified id settles as %s', (provider, expected) => {
    let model = 'anthropic/claude-sonnet-4-5';
    const setModel = (next: string) => {
      model = next;
    };
    renderHook(() => useModelNormalization(provider, model, setModel, true, null));
    expect(model).toBe(expected);
  });
});
