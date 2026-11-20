// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { splitViewAtom } from '../atoms';
import { useIsPaneActive } from './use-is-pane-active';

function renderPanes(paneCount: number) {
  const store = createStore();
  store.set(splitViewAtom, {
    chatIds: Array.from({ length: paneCount }, (_, i) => `chat-${i}`),
    ratios: Array(paneCount).fill(1 / paneCount),
    activePaneIndex: 0,
    layout: 'horizontal' as const,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  const renders = Array(paneCount).fill(0);
  const panes = Array.from({ length: paneCount }, (_, i) =>
    renderHook(
      () => {
        renders[i] += 1;
        return useIsPaneActive(i);
      },
      { wrapper },
    ),
  );
  return { store, renders, panes };
}

describe('useIsPaneActive', () => {
  it('re-renders only the panes whose focus flips', () => {
    const { store, renders, panes } = renderPanes(3);
    const before = [...renders];

    act(() => store.set(splitViewAtom, (sv) => ({ ...sv, activePaneIndex: 1 })));

    expect(panes.map((p) => p.result.current)).toEqual([false, true, false]);
    expect(renders.map((n, i) => n - before[i])).toEqual([1, 1, 0]);
  });
});
